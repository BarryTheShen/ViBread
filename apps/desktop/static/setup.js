const $ = (id) => document.getElementById(id);
for (const step of ["toolchain", "seed"]) $(step).querySelector("progress").removeAttribute("value");
window.vibread.on("setup:progress", ({ step, message, fraction, state }) => {
  const item = $(step);
  if (!item) return;
  item.className = state ?? "active";
  item.querySelector(".state").textContent = state === "done" ? "done" : state === "skipped" ? "already installed" : "working…";
  if (message) item.querySelector(".msg").textContent = message;
  const bar = item.querySelector("progress");
  if (state === "done" || state === "skipped") bar.value = 1;
  else if (typeof fraction === "number" && fraction > 0) bar.value = fraction;
  else bar.removeAttribute("value");
  $("error").style.display = "none";
  $("retry").disabled = true;
  $("status").textContent = "";
});
window.vibread.on("setup:error", ({ step, message, logPath }) => {
  const item = step ? $(step) : undefined;
  if (item) {
    item.className = "failed";
    item.querySelector(".state").textContent = "failed";
    item.querySelector("progress").value = 0;
  }
  $("error").style.display = "block";
  $("error").textContent = `${message}\n\nLog: ${logPath}`;
  $("retry").disabled = false;
  $("status").textContent = "Check your internet connection, then retry.";
});
$("retry").addEventListener("click", () => window.vibread.invoke("setup:retry"));
$("logs").addEventListener("click", () => window.vibread.invoke("setup:open-logs"));
