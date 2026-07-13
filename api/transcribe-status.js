// Vercel Serverless Function: /api/transcribe/status
// 检查转写环境依赖（Vercel 环境下大部分依赖不可用）

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  res.status(200).json({
    ready: false,
    checks: {
      python3: false,
      yt_dlp: false,
      ffmpeg: false,
      faster_whisper: false,
      pyannote: false,
      hf_token: false
    },
    message: 'Vercel Serverless 环境不支持视频转写，请在本地运行 Demo（node server.js）'
  });
};
