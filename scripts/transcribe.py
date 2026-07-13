#!/usr/bin/env python3
"""
LiveWiki — 视频逐字稿 + 发言人识别管线
依赖: yt-dlp, ffmpeg, faster-whisper, pyannote.audio

用法:
  python3 transcribe.py --url <VIDEO_URL> [--output <OUTPUT_DIR>] [--hf-token <TOKEN>]
  
输出 JSON 到 stdout:
  {
    "ok": true,
    "text": "【发言人A】\\n[00:01.23] 文本内容\\n...",
    "speakers": [{"id": "SPEAKER_00", "name": "孟庆 (Blade Meng)", "segments": 15}],
    "duration": 3600.5,
    "word_count": 15000
  }
"""

import os
import sys
import json
import argparse
import subprocess
import tempfile
import shutil
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="LiveWiki 视频逐字稿 + 发言人识别")
    parser.add_argument("--url", default=None, help="视频 URL")
    parser.add_argument("--file", default=None, help="本地视频/音频文件路径")
    parser.add_argument("--output", default=None, help="输出目录（默认临时目录）")
    parser.add_argument("--hf-token", default=os.environ.get("HF_TOKEN", ""), help="HuggingFace token")
    parser.add_argument("--whisper-model", default="small", help="Whisper 模型大小 (tiny/base/small/medium/large-v3)")
    parser.add_argument("--model-path", default=None, help="本地模型路径（优先于 whisper-model）")
    parser.add_argument("--device", default="auto", help="计算设备 (auto/cpu/cuda/mps)")
    parser.add_argument("--skip-diarization", action="store_true", help="跳过发言人识别")
    parser.add_argument("--referer", default="", help="落地页来源 URL，用作 Referer 头以绕过防盗链")
    args = parser.parse_args()

    if not args.url and not args.file:
        print(json.dumps({"ok": False, "error": "请提供 --url 或 --file 参数"}))
        sys.exit(1)

    # 输出目录
    if args.output:
        output_dir = Path(args.output)
        output_dir.mkdir(parents=True, exist_ok=True)
    else:
        output_dir = Path(tempfile.mkdtemp(prefix="livewiki_"))

    video_file = output_dir / "video.mp4"
    audio_file = output_dir / "audio.wav"
    transcript_file = output_dir / "transcript_with_speakers.txt"

    try:
        if args.file:
            # ── 本地文件模式 ──
            input_path = Path(args.file)
            if not input_path.exists():
                raise RuntimeError(f"文件不存在: {args.file}")
            print(f"==> [1/4] 使用本地文件: {input_path.name} ({input_path.stat().st_size / 1024 / 1024:.1f} MB)", file=sys.stderr)
            video_file = input_path  # 直接使用原文件
        else:
            # ── URL 下载模式 ──
            # ── Step 1: 下载视频 ──
            print("==> [1/4] 下载视频...", file=sys.stderr)

            # 防盗链：若提供了落地页来源，附带 Referer / Origin 头
            ytdlp_extra = []
            ffmpeg_headers = []
            if args.referer:
                ytdlp_extra += ["--add-header", f"Referer:{args.referer}"]
                origin = args.referer
                if "://" in origin:
                    origin = origin.split("://", 1)[1]
                origin = origin.split("/", 1)[0]
                ytdlp_extra += ["--add-header", f"Origin:https://{origin}"]
                ffmpeg_headers = ["-headers", f"Referer: {args.referer}\r\n"]

            result = subprocess.run(
                [sys.executable, "-m", "yt_dlp", args.url, "-o", str(video_file),
                 "--no-playlist", "--force-ipv4"] + ytdlp_extra,
                capture_output=True, text=True, timeout=600
            )
            if result.returncode != 0:
                # yt-dlp 可能找不到，尝试用 ffmpeg 直接下载
                print("yt-dlp 失败，尝试 ffmpeg 直接下载...", file=sys.stderr)
                subprocess.run(
                    ["ffmpeg", "-i", args.url, "-c", "copy", str(video_file), "-y"] + ffmpeg_headers,
                    capture_output=True, text=True, timeout=600, check=True
                )

            # 检查视频文件
            if not video_file.exists() or video_file.stat().st_size == 0:
                raise RuntimeError(f"视频下载失败: {video_file} 不存在或为空")

        # ── Step 2: 提取音频 ──
        print("==> [2/4] 提取音频...", file=sys.stderr)
        subprocess.run(
            ["ffmpeg", "-i", str(video_file),
             "-vn", "-ac", "1", "-ar", "16000",
             "-acodec", "pcm_s16le", str(audio_file), "-y"],
            capture_output=True, text=True, timeout=300, check=True
        )

        # ── Step 3: Whisper ASR 转写 ──
        print("==> [3/4] Whisper 转写中...", file=sys.stderr)
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise RuntimeError("faster-whisper 未安装，请运行: pip install faster-whisper")

        # 设备选择
        device = args.device
        if device == "auto":
            try:
                import torch
                if torch.cuda.is_available():
                    device = "cuda"
                elif torch.backends.mps.is_available():
                    device = "cpu"  # faster-whisper 对 mps 支持有限
                else:
                    device = "cpu"
            except ImportError:
                device = "cpu"

        compute_type = "float16" if device == "cuda" else "int8"
        
        # 模型路径优先级：--model-path > 环境变量 WHISPER_MODEL_DIR > --whisper-model
        local_model_dir = os.environ.get("WHISPER_MODEL_DIR", "")
        model_name = args.model_path or local_model_dir or args.whisper_model
        
        print(f"  设备: {device}, 模型: {model_name}, 计算精度: {compute_type}", file=sys.stderr)
        
        asr_model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, audio_info = asr_model.transcribe(
            str(audio_file),
            language="zh",
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            word_timestamps=True
        )

        asr_segments = [
            {"start": s.start, "end": s.end, "text": s.text.strip()}
            for s in segments
        ]

        if not asr_segments:
            raise RuntimeError("ASR 转写结果为空")

        print(f"  转写完成: {len(asr_segments)} 个片段, 时长 {audio_info.duration:.1f}s", file=sys.stderr)

        # ── Step 4: 说话人分离 ──
        speaker_segments = []
        skip_diarization = args.skip_diarization or not args.hf_token

        if not skip_diarization:
            print("==> [4/4] 说话人识别中...", file=sys.stderr)
            try:
                from pyannote.audio import Pipeline
                import torch

                diarization_pipeline = Pipeline.from_pretrained(
                    "pyannote/speaker-diarization-3.1",
                    use_auth_token=args.hf_token
                )
                if device == "cuda":
                    diarization_pipeline.to(torch.device("cuda"))

                diarization = diarization_pipeline(str(audio_file))

                speaker_segments = [
                    {"start": turn.start, "end": turn.end, "speaker": speaker}
                    for turn, _, speaker in diarization.itertracks(yield_label=True)
                ]
                print(f"  识别到 {len(set(s['speaker'] for s in speaker_segments))} 位发言人", file=sys.stderr)
            except Exception as e:
                print(f"  说话人识别失败（跳过）: {e}", file=sys.stderr)
                skip_diarization = True
        else:
            print("==> [4/4] 跳过说话人识别（无 HF_TOKEN）", file=sys.stderr)

        # ── 合并 ASR + 说话人 ──
        def get_speaker(start, end, speaker_segs):
            if not speaker_segs:
                return "UNKNOWN"
            best_speaker = "UNKNOWN"
            best_overlap = 0
            for seg in speaker_segs:
                overlap = min(end, seg["end"]) - max(start, seg["start"])
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_speaker = seg["speaker"]
            return best_speaker

        # 已知演讲者映射（可手动调整）
        SPEAKER_MAP = {
            "SPEAKER_00": "发言人 1",
            "SPEAKER_01": "发言人 2",
            "SPEAKER_02": "发言人 3",
            "SPEAKER_03": "发言人 4",
            "SPEAKER_04": "发言人 5",
        }

        # 生成逐字稿文本
        transcript_lines = []
        prev_speaker = None
        speaker_stats = {}

        for seg in asr_segments:
            raw_speaker = get_speaker(seg["start"], seg["end"], speaker_segments)
            speaker = SPEAKER_MAP.get(raw_speaker, raw_speaker)
            
            speaker_stats[speaker] = speaker_stats.get(speaker, 0) + 1

            timestamp = f"[{int(seg['start']//60):02d}:{seg['start']%60:05.2f}]"

            if speaker != prev_speaker:
                transcript_lines.append(f"\n【{speaker}】")
                prev_speaker = speaker

            transcript_lines.append(f"{timestamp} {seg['text']}")

        transcript_text = "\n".join(transcript_lines)

        # 保存到文件
        with open(transcript_file, "w", encoding="utf-8") as f:
            f.write(transcript_text)

        # 构建输出
        speakers_list = [
            {"id": k, "name": k, "segments": v}
            for k, v in sorted(speaker_stats.items(), key=lambda x: -x[1])
        ]

        output = {
            "ok": True,
            "text": transcript_text,
            "speakers": speakers_list,
            "duration": audio_info.duration if audio_info else 0,
            "word_count": sum(len(s["text"]) for s in asr_segments),
            "segment_count": len(asr_segments),
            "video_file": str(video_file),
            "transcript_file": str(transcript_file),
        }

        # 输出 JSON 到 stdout
        print(json.dumps(output, ensure_ascii=False))

    except Exception as e:
        error_output = {"ok": False, "error": str(e)}
        print(json.dumps(error_output, ensure_ascii=False))
        sys.exit(1)
    finally:
        # 清理音频文件（保留视频和逐字稿）
        if audio_file.exists():
            audio_file.unlink()


if __name__ == "__main__":
    main()
