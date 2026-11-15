// 달란트 시장 게시글의 댓글 등록 버튼 옆에 "구매" 버튼을 붙인다 (시청자용).
//
// 동작:
//   1. 이 방송국에서 열려 있는 시장 글 번호 목록을 받아 캐시한다 (방송국당 1분에 한 번)
//   2. 지금 보는 글 번호가 그 목록에 없으면 여기서 끝 — 요청이 더 나가지 않는다
//   3. 있으면 보상 목록과 잔액을 받아 댓글 등록 버튼 옆에 "구매" 버튼을 넣는다
//   4. 누르면 보상 목록과 내 달란트가 뜨고, 고른 항목이 댓글 입력창에 채워진다
//
// 예전에는 게시글 제목이 "[달란트 시장]"으로 시작하는지 보고 걸렀지만,
// 그러려면 글을 열 때마다 SOOP 게시글 API를 먼저 불러야 했다.
// 글 번호로 대조하면 요청이 줄고, 스트리머가 제목을 자유롭게 쓸 수 있다.
//
// **댓글 등록은 사용자가 직접 누른다.** 확장이 대신 글을 쓰지 않는다.
// 실제 차감은 스트리머가 페이지를 닫을 때 서버가 댓글을 읽어 처리하므로,
// 여기 표시되는 잔액은 참고용이다.

const MARK = "data-soopmarket";
const INFO_API = "https://afevent2.sooplive.com/api/get_private_info.php";
const SERVER_URL = "https://soop-talent.cagea1.com";
// 시장 글 목록 캐시 수명. 스트리머가 시장을 막 열었을 때 시청자가 오래 기다리지 않을 정도로 짧게.
const MARKET_TTL_MS = 60 * 1000;

/** CSS Modules 접두사로 요소를 찾는다. 해시 부분보다 오래간다. */
function byPrefix(prefix, root = document) {
  return [...root.querySelectorAll("[class]")].filter((el) =>
    String(el.className).split(/\s+/).some((c) => c.startsWith(prefix + "__")));
}
const firstByPrefix = (p, root = document) => byPrefix(p, root)[0] ?? null;

function parseLocation() {
  const m = location.pathname.match(/^\/station\/([^/]+)\/post\/(\d+)/);
  return m ? { bid: m[1], titleNo: m[2] } : null;
}

async function getSoopUser() {
  try {
    const r = await fetch(INFO_API, { credentials: "include" });
    const j = await r.json();
    const ch = j?.CHANNEL;
    if (Number(ch?.IS_LOGIN) !== 1 || !ch?.LOGIN_ID) return null;
    return { id: ch.LOGIN_ID, nick: ch.LOGIN_NICK ?? "" };
  } catch {
    return null;
  }
}

/**
 * 이 방송국에서 열려 있는 시장 글 번호들.
 *
 * 게시글을 넘길 때마다 서버를 부르지 않도록 방송국별로 캐시한다.
 * 서버가 죽어 있거나 응답이 이상하면 빈 목록으로 두고 조용히 넘어간다 —
 * 시장이 아닌 글에서 오류를 띄우는 편이 더 나쁘다.
 */
const marketCache = new Map(); // bid -> { titleNos: Set<string>, at: number }

async function getMarketPosts(serverUrl, bid) {
  const hit = marketCache.get(bid);
  if (hit && Date.now() - hit.at < MARKET_TTL_MS) return hit.titleNos;

  let titleNos = new Set();
  try {
    const r = await fetch(`${serverUrl}/api/viewer/markets?bid=${encodeURIComponent(bid)}`);
    if (r.ok) {
      const j = await r.json();
      titleNos = new Set((j?.titleNos ?? []).map(String));
    }
  } catch {
    // 서버에 닿지 못함 — 이번 주기는 비어 있는 것으로 본다
  }
  marketCache.set(bid, { titleNos, at: Date.now() });
  return titleNos;
}

// ---------------------------------------------------------------------------
// 댓글 입력창
// ---------------------------------------------------------------------------

/**
 * React가 관리하는 입력창에 값을 넣는다.
 * value를 직접 대입하면 React가 알아채지 못하므로
 * 네이티브 setter로 넣고 input 이벤트를 직접 발생시킨다.
 */
function setInputValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function findCommentInput() {
  return firstByPrefix("CommentWriteForm_realTextArea")
    ?? firstByPrefix("CommentWriteForm_textArea")
    ?? document.querySelector("textarea");
}

function fillComment(text) {
  const input = findCommentInput();
  if (!input) return false;
  input.focus();
  if (input.isContentEditable) {
    input.textContent = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    setInputValue(input, text);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 구매 패널
// ---------------------------------------------------------------------------

/**
 * 담을 수 있는 최대 개수.
 * 총 수량과 인당 제한 중 더 빡빡한 쪽을 따른다.
 * 여기서 막는 것은 편의일 뿐이며, 실제 판정은 정산 때 서버가 다시 한다.
 */
function maxFor(it) {
  const limits = [it.stock, it.perUserLimit].filter((n) => n != null);
  return limits.length ? Math.min(...limits) : 99;
}

function buildPanel(data, onClose) {
  const selected = new Map(); // itemId -> quantity

  const panel = document.createElement("div");
  panel.className = "soopmarket-panel";
  panel.setAttribute(MARK, "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "달란트 시장 보상 선택");

  const head = document.createElement("div");
  head.className = "soopmarket-head";
  const title = document.createElement("strong");
  title.textContent = data.title || "달란트 시장";
  const balance = document.createElement("span");
  balance.className = "soopmarket-balance";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "soopmarket-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "닫기");
  close.addEventListener("click", onClose);
  head.append(title, balance, close);

  const list = document.createElement("div");
  list.className = "soopmarket-items";

  const total = document.createElement("span");
  total.className = "soopmarket-total";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "soopmarket-btn primary";
  apply.textContent = "댓글에 넣기";

  const foot = document.createElement("div");
  foot.className = "soopmarket-foot";
  foot.append(total, apply);

  const warn = document.createElement("div");
  warn.className = "soopmarket-warn";

  const refresh = () => {
    let sum = 0;
    for (const [id, qty] of selected) {
      const it = data.items.find((x) => x.id === id);
      if (it) sum += it.price * qty;
    }
    const rest = data.balance - sum;
    balance.textContent = `보유 ${data.balance.toLocaleString("ko-KR")}`;
    total.textContent =
      `합계 ${sum.toLocaleString("ko-KR")} · 남는 달란트 ${rest.toLocaleString("ko-KR")}`;
    const over = rest < 0;
    total.classList.toggle("over", over);
    apply.disabled = sum === 0 || over;
    warn.textContent = over ? "보유한 달란트보다 많이 담았습니다." : "";
  };

  for (const it of data.items) {
    const row = document.createElement("div");
    row.className = "soopmarket-item";

    // 미리보기가 없으면 빈 칸을 둔다. 있고 없고에 따라 줄이 어긋나지 않게.
    const thumb = document.createElement("span");
    thumb.className = "soopmarket-thumb";
    if (it.imageId) {
      const img = document.createElement("img");
      img.src = `${data.serverUrl}/api/shop/images/${it.imageId}`;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "soopmarket-name";
    name.textContent = it.name;

    const price = document.createElement("span");
    price.className = "soopmarket-price";
    price.textContent = [
      `${it.price.toLocaleString("ko-KR")} 달란트`,
      it.stock != null ? `남은 수량 ${it.stock}` : null,
      it.perUserLimit != null ? `인당 ${it.perUserLimit}개까지` : null,
    ].filter(Boolean).join(" · ");

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "soopmarket-btn qty";
    minus.textContent = "−";
    minus.setAttribute("aria-label", `${it.name} 수량 줄이기`);

    const qty = document.createElement("span");
    qty.className = "soopmarket-qty";
    qty.textContent = "0";

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "soopmarket-btn qty";
    plus.textContent = "+";
    plus.setAttribute("aria-label", `${it.name} 수량 늘리기`);

    const set = (n) => {
      const v = Math.max(0, Math.min(n, maxFor(it)));
      if (v === 0) selected.delete(it.id);
      else selected.set(it.id, v);
      qty.textContent = String(v);
      refresh();
    };
    minus.addEventListener("click", () => set((selected.get(it.id) ?? 0) - 1));
    plus.addEventListener("click", () => set((selected.get(it.id) ?? 0) + 1));

    row.append(thumb, name, price, minus, qty, plus);
    list.append(row);
  }

  apply.addEventListener("click", () => {
    const parts = [];
    for (const [id, q] of selected) {
      const it = data.items.find((x) => x.id === id);
      if (!it) continue;
      parts.push(q > 1 ? `${it.name} x${q}` : it.name);
    }
    if (!parts.length) return;

    const text = `${data.prefix} ${parts.join(", ")}`;
    if (fillComment(text)) {
      onClose();
      return;
    }
    warn.textContent = "댓글 입력창을 찾지 못했습니다. 아래 문구를 직접 붙여넣어 주세요.";
    const pre = document.createElement("pre");
    pre.className = "soopmarket-fallback";
    pre.textContent = text;
    panel.append(pre);
  });

  panel.append(head, list, foot, warn);
  refresh();
  return panel;
}

// ---------------------------------------------------------------------------
// 주입 — 댓글 등록 버튼 옆
// ---------------------------------------------------------------------------

function injectBuyButton(data, me) {
  // 등록 버튼이 있는 줄. 구매는 댓글 작성의 일부이므로 여기가 맞는 자리다.
  const host = firstByPrefix("CommentWriteForm_actionButton");
  if (!host || host.querySelector(`[${MARK}]`)) return;

  const slot = document.createElement("span");
  slot.className = "soopmarket-slot";
  slot.setAttribute(MARK, "slot");

  const buy = document.createElement("button");
  buy.type = "button";
  buy.className = "soopmarket-btn buy";
  buy.textContent = "구매";
  buy.setAttribute(MARK, "buy");

  let panel = null;
  const closePanel = () => {
    panel?.remove();
    panel = null;
    buy.setAttribute("aria-expanded", "false");
  };
  buy.setAttribute("aria-expanded", "false");

  buy.addEventListener("click", () => {
    if (panel) { closePanel(); return; }
    if (!me) {
      alert("SOOP에 로그인하면 보유 달란트를 확인하고 보상을 신청할 수 있습니다.");
      return;
    }
    panel = buildPanel(data, closePanel);
    // 댓글 작성 영역 아래에 펼친다.
    const anchor = firstByPrefix("CommentWriteForm_commentBox") ?? host.parentElement ?? host;
    anchor.insertAdjacentElement("afterend", panel);
    buy.setAttribute("aria-expanded", "true");
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  slot.append(buy);
  // 등록 버튼 왼쪽에 둔다 — 구매를 고른 다음 등록하는 순서와 맞다.
  host.prepend(slot);
}

// ---------------------------------------------------------------------------

let currentKey = null;
let running = false;

async function inject() {
  const loc = parseLocation();
  if (!loc) return;
  if (running) return;

  const key = `${loc.bid}/${loc.titleNo}`;
  // 댓글 폼은 늦게 그려진다. 버튼이 아직 없으면 같은 글이어도 다시 시도한다.
  const host = firstByPrefix("CommentWriteForm_actionButton");
  if (key === currentKey && (!host || host.querySelector(`[${MARK}]`))) return;

  running = true;
  try {
    // 1. 글 번호 대조 — 여기서 대부분의 게시글이 걸러지고, 캐시가 살아 있으면 요청이 없다
    const markets = await getMarketPosts(SERVER_URL, loc.bid);
    if (!markets.has(String(loc.titleNo))) {
      currentKey = key;
      return;
    }

    // 2. 보상 목록과 잔액을 받는다
    const me = await getSoopUser();
    const q = new URLSearchParams({ titleNo: loc.titleNo });
    if (me) q.set("userId", me.id);

    const res = await fetch(`${SERVER_URL}/api/viewer/shop?${q}`);
    if (!res.ok) { currentKey = key; return; }
    const data = await res.json();
    if (!data?.items?.length) { currentKey = key; return; }
    data.serverUrl = SERVER_URL; // 미리보기 이미지 주소를 만드는 데 쓴다

    // 3. 구매 버튼 주입
    if (firstByPrefix("CommentWriteForm_actionButton")) {
      injectBuyButton(data, me);
      currentKey = key;
    }
  } catch (e) {
    console.debug("[SoopTalent] 달란트 시장 확인 실패:", e.message);
  } finally {
    running = false;
  }
}

// SPA라 경로 변경과 비동기 렌더링을 계속 지켜본다.
let lastPath = location.pathname;
let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(inject, 500);
}

new MutationObserver(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    currentKey = null;
    document.querySelectorAll(`[${MARK}]`).forEach((el) => el.remove());
  }
  schedule();
}).observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener("popstate", () => { currentKey = null; schedule(); });
schedule();
