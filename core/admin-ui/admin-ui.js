(function () {
  const BASE = "/c360"; // ton prefix nginx. Si tu appelles direct 8080, mets "".

  function ready(fn){
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function $(id){ return document.getElementById(id); }
  function setMsg(text){
    const el = $("err") || $("msg");
    if (!el) return;
    el.style.display = "block";
    el.textContent = text;
  }

  async function doLogin(){
    const password = ($("pwd")?.value || "").trim();
    setMsg("Connexion en cours...");

    try{
      const res = await fetch(BASE + "/v1/admin/ui/login", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        credentials: "include",
        body: JSON.stringify({ password }),
      });

      const txt = await res.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { ok:false, raw: txt }; }

      if (!res.ok || !data.ok){
        setMsg("Login failed: " + (data.error || ("HTTP " + res.status)));
        return;
      }

      setMsg("OK ✅ Redirection...");
      window.location.href = BASE + "/v1/admin/ui";
    } catch(e){
      setMsg("Network error: " + String(e));
    }
  }

  ready(function(){
    // Indicateur visible que le JS est bien exécuté
    const badge = document.createElement("div");
    badge.textContent = "JS loaded ✅";
    badge.style.cssText = "position:fixed;bottom:10px;right:10px;font-size:12px;color:#111;background:#fff;border:1px solid #ddd;border-radius:10px;padding:6px 10px;z-index:9999";
    document.body.appendChild(badge);

    // Supporte plusieurs IDs possibles
    const btn = $("loginBtn") || $("btn") || document.querySelector("button[type='submit']") || document.querySelector("button");
    if (!btn){
      setMsg("ERROR: login button not found in DOM");
      return;
    }

    btn.addEventListener("click", function(e){
      e.preventDefault();
      doLogin();
    });

    // Bonus: Enter dans le champ password
    const pwd = $("pwd");
    if (pwd){
      pwd.addEventListener("keydown", (e)=>{
        if (e.key === "Enter") doLogin();
      });
    }
  });
})();

