// 统一的 Python 转写执行器
//
// 原先 server.js 的 /api/transcribe-file 与 server_handlers.mjs 的 /api/transcribe
// 各自维护了一份近乎逐行相同的「拼 args → execFile → 超时/错误/JSON 解析」逻辑（约 60 行）。
// 这里收敛为单一实现，两端（本地 server.js / Vercel api/*.mjs）共用。
//
// 安全约定：HF_TOKEN 通过子进程 env 传递，绝不出现在 argv 中（否则会被命令行日志打出来）。

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { TIMEOUT } from '../lib/constants.mjs';
import { createLogger, safeCmd } from '../lib/log.mjs';

const log = createLogger('transcribe');

// 本地模型目录（若存在则优先使用，避免联网下载）
function localModelPath() {
  const p = path.join(process.cwd(), 'models', 'whisper-small');
  return fs.existsSync(path.join(p, 'model.bin')) ? p : null;
}

// 最近一次逐字稿的稳定落点：/api/last-transcript 会读这里。
// 临时工作目录跑完即删，但这份副本会保留，保证「转写完 → 一键导入」链路可用。
function lastTranscriptPath() {
  return process.env.LW_LAST_TRANSCRIPT_PATH
    || path.join(os.tmpdir(), 'lw_out', 'transcript_with_speakers.txt');
}

function publishLastTranscript(text) {
  if (!text) return null;
  try {
    const target = lastTranscriptPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    return target;
  } catch (e) {
    log.swallow('落盘最近逐字稿', e);
    return null;
  }
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    log.swallow(`清理临时目录 ${target}`, e);
  }
}

export function buildTranscribeArgs({ source, outputDir, whisperModel, skipDiarization, referer }) {
  const args = [
    path.join(process.cwd(), 'scripts', 'transcribe.py'),
    '--output', outputDir,
    '--whisper-model', whisperModel || 'small',
  ];
  if (source.type === 'file') args.push('--file', source.value);
  else args.push('--url', source.value);

  const modelPath = localModelPath();
  if (modelPath) args.push('--model-path', modelPath);
  if (skipDiarization) args.push('--skip-diarization');
  if (referer) args.push('--referer', referer); // 落地页来源，用作 Referer 绕过防盗链
  return args;
}

/**
 * 执行一次转写。
 *
 * @param {object} opts
 * @param {{type:'url'|'file', value:string}} opts.source
 * @param {string} [opts.whisperModel]
 * @param {boolean} [opts.skipDiarization]
 * @param {string} [opts.referer]
 * @param {string[]} [opts.cleanupPaths] 完成后需递归删除的临时目录（如上传目录）
 * @returns {Promise<{ok:boolean, code:number, result?:object, error?:string, hint?:string}>}
 *          永不 reject，调用方只需把 code 映射为 HTTP 状态码。
 */
export function runTranscribe({
  source,
  whisperModel = 'small',
  skipDiarization = false,
  referer = '',
  cleanupPaths = [],
} = {}) {
  return new Promise((resolve) => {
    let outputDir;
    try {
      outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livewiki_transcribe_'));
    } catch (e) {
      return resolve({ ok: false, code: 500, error: '无法创建临时目录: ' + e.message });
    }

    const args = buildTranscribeArgs({ source, outputDir, whisperModel, skipDiarization, referer });

    // 只打印脱敏后的命令行；HF_TOKEN 走 env，不在 argv 中
    log.info('启动 Python 脚本:', safeCmd('python3', args));

    const child = execFile(
      'python3',
      args,
      {
        timeout: TIMEOUT.TRANSCRIBE,
        maxBuffer: 10 * 1024 * 1024,
        // 敏感令牌经环境变量传递，避免出现在进程参数 / 日志里
        env: { ...process.env, HF_TOKEN: process.env.HF_TOKEN || '' },
      },
      (err, stdout, stderr) => {
        // 无论成功失败都清理临时工作目录（下载的视频、中间 wav 等）
        rmrf(outputDir);
        for (const p of cleanupPaths) rmrf(p);

        if (err && err.killed) {
          log.error('转写超时或被终止');
          return resolve({ ok: false, code: 504, error: '转写超时（超过 15 分钟），请尝试较短的音频' });
        }
        if (err) {
          log.error('Python 脚本失败:', err.message);
          if (stderr) log.error('stderr:', String(stderr).slice(0, 500));
          return resolve({
            ok: false,
            code: 500,
            error: '转写失败: ' + (err.message || '未知错误'),
            hint: '请确保已安装 yt-dlp, ffmpeg, faster-whisper',
          });
        }

        // 契约：Python 只向 stdout 输出一行 JSON，其余进度走 stderr
        const lines = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
        let result;
        try {
          result = JSON.parse(lines[lines.length - 1]);
        } catch {
          log.error('JSON 解析失败:', String(stdout).slice(0, 500));
          return resolve({ ok: false, code: 500, error: '转写结果解析失败' });
        }

        if (!result.ok) {
          return resolve({ ok: false, code: 500, error: result.error || '转写失败' });
        }

        log.info(`成功: ${result.word_count} 字, ${result.segment_count} 片段`);
        // 临时工作目录马上会被删除，这里把逐字稿另存到稳定路径，
        // 供 /api/last-transcript 读取，并把 transcript_file 指向它（避免留下悬空路径）
        const stable = publishLastTranscript(result.text);
        if (stable) {
          result.lastTranscriptPath = stable;
          result.transcript_file = stable;
        }
        resolve({ ok: true, code: 200, result });
      }
    );

    // 防御：Promise 已 settle 后 child 再出错也不应导致未捕获异常
    child.on('error', (e) => {
      log.error('子进程启动失败:', e.message);
      rmrf(outputDir);
      for (const p of cleanupPaths) rmrf(p);
      resolve({ ok: false, code: 500, error: '无法启动转写进程: ' + e.message });
    });
  });
}
