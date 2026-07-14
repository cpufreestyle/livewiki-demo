// Vercel Serverless Function: /api/sample

import { SAMPLE_TRANSCRIPT } from '../lib/pipeline.mjs';

export default (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  res.status(200).json({ text: SAMPLE_TRANSCRIPT });
};
