const $ = (id) => document.getElementById(id);
async function refresh() {
  const status = await window.vibread.invoke("apikey:status");
  $("status").textContent = status.set ? "A key is saved." : "No key saved.";
  $("clear").disabled = !status.set;
  if (!status.secureStorage) {
    $("hint").textContent = "No secure credential store is available on this system, so the key can't be saved.";
    $("save").disabled = true;
  }
}
$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("key").value.trim();
  if (!key) return;
  $("save").disabled = true;
  $("status").textContent = "Saving and restarting the server…";
  try {
    await window.vibread.invoke("apikey:save", key);
    window.vibread.invoke("window:close");
  } catch (error) {
    $("status").textContent = String(error.message ?? error).replace(/^Error invoking remote method '[^']+': /, "");
    $("save").disabled = false;
  }
});
$("clear").addEventListener("click", async () => {
  $("status").textContent = "Removing and restarting the server…";
  await window.vibread.invoke("apikey:clear");
  $("key").value = "";
  await refresh();
});
$("cancel").addEventListener("click", () => window.vibread.invoke("window:close"));
refresh();
