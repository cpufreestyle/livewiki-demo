// 站点专属的「免验证码报名」UI 自动化
//
// 背景：这段逻辑原先内嵌在 resolve_video_url.js 的 tryPlaywright() 里（约 70 行），
// 把「通用网络嗅探」与「业务级表单填写」混在一起，且中文按钮文案是针对
// NVIDIA SCRM / Jingsocial 单页硬编码的。这里抽出为独立模块，
// 文案改为按域名匹配的 profile 表，便于扩展其它活动页。

import { TIMEOUT } from '../lib/constants.mjs';
import { createLogger } from '../lib/log.mjs';

const log = createLogger('autofill');

// 默认（通用）文案：任何站点都尝试
const GENERIC = {
  cookieBanner: ['全部接受', '接受全部', '同意', '接受', '我同意', '确认', '知道了', 'Got it', 'Accept', '同意并继续'],
  openFormCta: ['注册并观看', '报名并观看', '立即报名', '我要报名', '报名观看', '观看直播', '直播回放', '注册', '报名', '观看回放'],
  submit: ['提交', '确定', '完成', '确认', '提交报名', '立即报名', '进入观看', '开始观看', '观看', 'Submit', 'OK'],
  play: ['观看', '立即观看', '去观看', '播放', '直播', '回放', '重播', 'Watch', 'Play', 'Replay', 'Live', '▶'],
  defaultName: 'LiveWiki User',
};

// 按 URL 子串匹配的站点配置，命中后与 GENERIC 合并（站点配置优先）
const SITE_PROFILES = [
  {
    match: /jingsocial|nvidia/i,
    defaultName: 'LiveWiki User',
  },
];

export function profileFor(url) {
  for (const p of SITE_PROFILES) {
    if (p.match.test(String(url || ''))) return { ...GENERIC, ...p };
  }
  return { ...GENERIC };
}

// 手机号输入框候选选择器（逗号分隔，Playwright 会匹配其中任意一个）
const PHONE_SELECTOR = [
  'input[type="tel"]',
  'input[name*="phone" i]',
  'input[id*="phone" i]',
  'input[name*="mobile" i]',
  'input[id*="mobile" i]',
  'input[placeholder*="手机" i]',
  'input[placeholder*="电话" i]',
  'input[placeholder*="手机号" i]',
].join(', ');

const NAME_SELECTOR = [
  'input[name*="name" i]:not([type="hidden"])',
  'input[id*="name" i]:not([type="hidden"])',
  'input[placeholder*="姓名" i]',
  'input[placeholder*="名字" i]',
].join(', ');

/**
 * 按文案依次尝试点击，任一命中即返回。
 * 用 force:true + 短超时，避免被横幅/遮罩拦截时长时间卡住。
 */
async function clickByText(page, labels, { timeout = TIMEOUT.CLICK, perLabel = 3 } = {}) {
  for (const label of labels) {
    let handles;
    try {
      handles = await page.getByText(label, { exact: false }).all();
    } catch {
      continue;
    }
    for (const h of handles.slice(0, perLabel)) {
      try {
        await h.click({ timeout, force: true });
        return true;
      } catch (e) {
        log.swallow(`点击「${label}」`, e);
      }
    }
  }
  return false;
}

/**
 * 免验证码报名流程：
 *   1) 接受 Cookie 横幅（否则后续点击会被拦截）
 *   2) 点击「注册并观看」等 CTA 打开报名表单（手机号框此时才出现）
 *   3) 填手机号 / 姓名，勾选协议
 *   4) 提交表单，等待播放器加载真实流
 *
 * 顺序很重要：必须先点开表单，再填手机号。
 *
 * @param {import('playwright').Page} page
 * @param {{phone?: string, name?: string, url?: string}} opts
 * @returns {Promise<boolean>} 是否走完了提交流程
 */
export async function autoRegister(page, { phone, name, url } = {}) {
  if (!phone) return false;
  const profile = profileFor(url);

  try {
    // 1) 接受 Cookie 横幅
    await clickByText(page, profile.cookieBanner, { timeout: 1000, perLabel: 4 });

    // 2) 点击报名 / 观看 CTA，打开表单
    await clickByText(page, profile.openFormCta, { timeout: 1500, perLabel: 3 });

    // 3) 等待手机号输入框出现（表单可能在弹窗 / 异步层里）
    //    用 waitForSelector 事件驱动，替代原先固定 sleep 轮询
    let phoneEl = null;
    try {
      phoneEl = await page.waitForSelector(PHONE_SELECTOR, { timeout: 8000, state: 'attached' });
    } catch {
      log.debug('未出现手机号输入框，跳过自动报名');
      return false;
    }

    // Playwright 原生 fill 可触发框架的受控输入事件；失败则退回 DOM 直填
    try {
      await phoneEl.fill(phone);
    } catch (e) {
      log.swallow('fill 手机号', e);
      try {
        await page.evaluate((sel, ph) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.focus();
          el.value = ph;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, PHONE_SELECTOR, phone);
      } catch (e2) {
        log.swallow('DOM 直填手机号', e2);
      }
    }

    // 顺带填姓名（报名表单常要求）
    try {
      const nameEl = await page.$(NAME_SELECTOR);
      if (nameEl) await nameEl.fill(name || profile.defaultName);
    } catch (e) {
      log.swallow('填写姓名', e);
    }

    // 勾选隐私 / 协议同意框（若提交按钮依赖它）
    try {
      const agree = await page.$('input[type="checkbox"]:not([checked])');
      if (agree) await agree.check({ timeout: 800 });
    } catch (e) {
      log.swallow('勾选协议', e);
    }

    // 4) 提交表单
    let submitted = await clickByText(page, profile.submit, { timeout: 1500, perLabel: 3 });
    if (!submitted) {
      // 兜底：点表单内的最后一个 button / submit
      try {
        await page.locator('button, input[type="submit"]').last().click({ timeout: 1500, force: true });
        submitted = true;
      } catch (e) {
        log.swallow('兜底提交', e);
      }
    }
    return submitted;
  } catch (e) {
    log.swallow('自动报名整体流程', e);
    return false;
  }
}

/**
 * 触发式播放器点击：很多落地页只有在点击「播放 / 观看」后
 * 才会向真实 CDN 请求 m3u8 / mp4。
 */
export async function clickPlay(page, { url } = {}) {
  const profile = profileFor(url);
  try {
    await clickByText(page, profile.play, { timeout: 1500, perLabel: 3 });
    // 顺便点击可能的播放器容器
    await page.locator('video, [class*="player"], [class*="video"], [id*="player"]')
      .first()
      .click({ timeout: 1500, force: true })
      .catch((e) => log.swallow('点击播放器容器', e));
    return true;
  } catch (e) {
    log.swallow('点击播放', e);
    return false;
  }
}

export { PHONE_SELECTOR, NAME_SELECTOR };
