---
name: ego-search
description: 网页检索与信息获取。先用 ego_script 单脚本提取 Bing/Google 结果；脚本异常、被拦或结果被导航文本稀释时，改走常规 ego 流程（ego_navigate + ego_snapshot + ego_read_element）兜底。
---

# ego-search

优先用 `ego_script` 跑一段顶层 `await` 单脚本：Bing 优先，无结果或被验证码拦下再切 Google。脚本只认「有信息量的标题」，凡是裸域名、「域名 › 面包屑」这类导航文本一律丢弃，所以至少拿到 2 条才算成功。

```javascript
const kw = "搜索关键词";
let success = false;

// 1. 优先 Bing：标题取 h2/h3 自身文本，链接按 h2 a → cite a → .b_tpcn a.tilk 顺序找
try {
  await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(kw)}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
  const bing = await page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const looksNav = (t) => !t || t.length < 4 || t.length > 180 || /^https?:\/\//i.test(t) || /^[a-z0-9.-]+\.[a-z]{2,}(\s|$)|\s›\s/i.test(t);
    const out = [];
    for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
      const head = li.querySelector('h2, h3');
      const link = (head && head.querySelector('a')) || li.querySelector('cite a') || li.querySelector('.b_tpcn a.tilk') || li.querySelector('a[href]');
      const title = clean(head && head.innerText) || clean(link && link.innerText);
      const url = (link && link.href) || '';
      const snipEl = li.querySelector('.b_caption p, .b_algoSlug, .b_lineclamp2, .b_lineclamp3, .b_snippet, p');
      const snippet = clean(snipEl && snipEl.innerText);
      if (title && url && !looksNav(title)) out.push({ title, url, snippet });
      if (out.length >= 8) break;
    }
    return out;
  });
  if (bing.length >= 2) {
    console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true, engine: 'bing', results: bing }));
    success = true;
  }
} catch (_) {}

// 2. 备选 Google：先自检验证码，再按容器取 h3 标题
if (!success) {
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(kw)}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
    const google = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const looksNav = (t) => !t || t.length < 4 || t.length > 180 || /^https?:\/\//i.test(t) || /^[a-z0-9.-]+\.[a-z]{2,}(\s|$)|\s›\s/i.test(t);
      if (document.querySelector('#captcha-form, #recaptcha') || location.pathname.includes('/sorry/')) {
        return { blocked: true, list: [] };
      }
      const out = [];
      for (const el of document.querySelectorAll('div.g, div[data-sncf], .tF2Cxc')) {
        const a = (el.querySelector('h3') && el.querySelector('h3').parentElement) || el.querySelector('a');
        const title = clean(el.querySelector('h3') && el.querySelector('h3').innerText);
        const url = (a && a.href) || '';
        const snipEl = el.querySelector('.VwiC3b, div[style*="-webkit-line-clamp"], .yXK7lf');
        const snippet = clean(snipEl && snipEl.innerText);
        if (title && url && !looksNav(title)) out.push({ title, url, snippet });
        if (out.length >= 8) break;
      }
      return { blocked: false, list: out };
    });
    if (!google.blocked && google.list.length >= 2) {
      console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: true, engine: 'google', results: google.list }));
      success = true;
    }
  } catch (_) {}
}

// 3. 失败回传：ok:false 就是「这次脚本效果不好」的信号
if (!success) {
  console.log('@@DSH_RESULT@@' + JSON.stringify({ ok: false, reason: 'EMPTY_OR_BLOCKED_OR_WEAK' }));
}
```

## 什么时候改走常规 ego 流程

出现下面任意一条，就判定为「脚本效果不好」，不要硬凑结果，改走常规 ego 流程兜底：

1. 脚本返回 `ok: false`（空结果、验证码、被重定向）；
2. 拿到的标题是裸域名、或形如「域名 › 面包屑路径」的导航文本；
3. 有效条目少于 2 条，或全是同一站点的栏目首页。

常规 ego 流程＝`ego_navigate` 打开搜索结果页 → `ego_snapshot` 读页面结构定位条目 → `ego_read_element` 逐条取真实标题与摘要，多步提取后再汇总；页面复杂、需登录或需要点击展开时同理。这一路要读页面，token 比脚本多，但拿到的内容更可靠。
