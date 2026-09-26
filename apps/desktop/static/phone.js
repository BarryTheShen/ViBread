const $ = (id) => document.getElementById(id);
window.vibread.invoke("phone:info").then(({ url, qr, lan }) => {
  $("url").textContent = url;
  $("qr").src = qr;
  $("note").textContent = lan
    ? "If the page doesn't load, allow ViBread through your firewall when your system asks (private networks only)."
    : "This computer has no local network address right now; connect to Wi-Fi and reopen this window.";
  $("copy").addEventListener("click", () => navigator.clipboard.writeText(url).then(() => ($("copy").textContent = "Copied")));
});
$("close").addEventListener("click", () => window.vibread.invoke("window:close"));
