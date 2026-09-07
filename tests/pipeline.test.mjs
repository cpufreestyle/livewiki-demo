// 处理管线纯函数单测
// 运行：npm test
//
// 关键点：这些用例必须完全离线、可重复。
// 因此在导入前就把 LLM 相关环境变量清掉，确保走内置规则引擎分支。

process.env.LW_CCSWITCH = '0';
for (const k of [
  'LW_STEPFUN_API_KEY', 'LW_NVIDIA_API_KEY', 'LW_LLM_API_KEY',
  'LW_STEPFUN_BASE_URL', 'LW_NVIDIA_BASE_URL', 'LW_LLM_BASE_URL',
]) {
  delete process.env[k];
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  preprocess,
  extractKeywords,
  detectRelations,
  segmentTopics,
  buildSection,
  processTranscript,
} from '../lib/pipeline.mjs';

test('preprocess 去除口语填充词', () => {
  const out = preprocess('那个我们今天讲的是嗯 AI 产品，就是说 API 调用。');
  assert.equal(out.includes('那个'), false);
  assert.equal(out.includes('嗯'), false);
  assert.equal(out.includes('就是说'), false);
  assert.ok(out.includes('AI 产品'));
});

test('preprocess 折叠多余空行并去空段落', () => {
  const out = preprocess('第一段内容足够长\n\n\n\n\n第二段内容也足够长');
  assert.equal(out.split('\n').length, 2);
});

test('preprocess 对重复短段落去重', () => {
  const line = '这是一个重复的短句';
  const out = preprocess([line, line, line].join('\n'));
  assert.equal(out.split('\n').filter(Boolean).length, 1);
});

test('extractKeywords 过滤停用词与功能字', () => {
  const kws = extractKeywords('我们这个产品就是需要关注 API 和 Token 成本，API 调用很关键', 6);
  assert.ok(Array.isArray(kws));
  assert.ok(kws.length <= 6);
  // 停用词 / 功能字不应成为关键词
  for (const stop of ['我们', '这个', '就是', '的', '和']) {
    assert.equal(kws.includes(stop), false, `不应把「${stop}」作为关键词`);
  }
  // 英文术语权重更高，应当被保留
  assert.ok(kws.some((k) => /API|Token/i.test(k)), '应识别出 API / Token 术语');
});

test('extractKeywords 尊重 topN 上限', () => {
  const long = '产品定位用户场景市场需求技术实现系统架构部署方案'.repeat(20);
  assert.ok(extractKeywords(long, 3).length <= 3);
});

test('detectRelations 只输出章节对且不重复', () => {
  const structured = [
    { title: 'A', keyPoints: ['产品定义要清晰', '用户场景要具体'] },
    { title: 'B', keyPoints: ['定义产品边界', '用户增长方法'] },
    { title: 'C', keyPoints: ['完全无关的内容', '另一个话题在这里'] },
  ];
  const rels = detectRelations(structured);
  // A 与 B 共享「产品」「定义」等概念词
  assert.equal(rels.length, 1);
  assert.equal(rels[0].from, 0);
  assert.equal(rels[0].to, 1);
  assert.ok(rels[0].sharedTerms.length >= 2);
});

test('detectRelations 对无关章节不产出关系', () => {
  const structured = [
    { title: 'A', keyPoints: ['产品定义要清晰'] },
    { title: 'B', keyPoints: ['完全不同的另一件事'] },
  ];
  assert.equal(detectRelations(structured).length, 0);
});

test('segmentTopics + buildSection 产出完整章节结构', () => {
  const text = [
    '这个产品定位要清楚，用户的需求和场景决定了市场空间有多大。',
    '技术架构方面，API 的调用和模型的部署实现需要认真考虑系统设计。',
  ].join('\n');
  const segments = segmentTopics(preprocess(text));
  assert.ok(segments.length >= 1);
  const section = buildSection(segments[0], 0, segments.length);
  assert.ok(section.title);
  assert.ok(typeof section.summary === 'string' && section.summary.length > 0);
  assert.ok(Array.isArray(section.keyPoints));
  assert.ok(Array.isArray(section.keywords));
  assert.ok(section.wordCount > 0);
});

test('processTranscript 端到端（规则引擎分支）', async () => {
  const text =
    '那个今天我们讲的是从 0 到 1 做一个 AI 产品。' +
    '首先要想清楚产品定位，用户是谁，场景是什么，市场空间有多大。' +
    '然后是技术架构，API 怎么调用，模型怎么部署，系统怎么实现。' +
    '最后是商业化，定价怎么定，成本怎么算，增长飞轮怎么转起来。';
  const result = await processTranscript(text, { useCache: false });

  assert.ok(result.structured.length >= 1, '应至少分出一个章节');
  assert.ok(result.output.markdown.includes('LiveWiki'));
  assert.ok(result.output.toc.length > 0);
  assert.equal(result.stats.llmUsed, false, '未配置 LLM 时应走规则引擎');
  assert.ok(result.stats.processingTime >= 0);
  assert.ok(Array.isArray(result.relations));
});
