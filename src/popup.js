const SERVER_URL = "https://soop-talent.cagea1.com";
const $ = (id) => document.getElementById(id);

function setConn(tone, label, detail) {
  $("connBadge").className = `badge ${tone}`;
  $("connBadge").textContent = label;
  $("connDetail").textContent = detail ?? "";
  $("connDetail").title = detail ?? "";
}

/** 로그인 없이 서비스 상태만 확인한다. */
async function check() {
  setConn("warn", "확인 중", "soop-talent.cagea1.com");
  try {
    const res = await fetch(`${SERVER_URL}/api/health`);
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const db = body?.database;
      if (db && db.tone !== "ok") {
        setConn("warn", "서버 점검 필요", db.detail || `데이터베이스 ${db.label}`);
        return;
      }
      setConn("ok", "연결됨", "soop-talent.cagea1.com");
      return;
    }
    setConn("bad", "서버 오류", `HTTP ${res.status}`);
  } catch {
    setConn("bad", "연결 안 됨", "SoopTalent 서버에 닿지 못했습니다.");
  }
}

$("recheck").addEventListener("click", async () => {
  const btn = $("recheck");
  btn.disabled = true;
  await check();
  btn.disabled = false;
});

check();
