const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("id-ID");
const format = (value) => number.format(BigInt(value));
const weight = (value) => value === "0" ? "—" : `${format(value)} kg`;
const stages = { Created: "Dibuat", InTransit: "Dalam perjalanan", Received: "Diterima", Treated: "Diolah" };
const roles = { generator: "Pabrik penghasil", oracle: "Oracle timbangan", transporter: "Pengangkut",
  processor: "Pengolah", auditor: "Auditor", regulator: "Regulator" };
const events = { ManifestCreated: "Manifest dibuat", WeightRecorded: "Berat dicatat",
  StatusChanged: "Status berubah", AnomalyDetected: "Anomali terdeteksi", ManuallyFlagged: "Ditandai auditor",
  FlagResolved: "Flag diselesaikan", TreatmentRecorded: "Pengolahan dicatat" };
const actions = {
  register: ["Daftarkan peran", ["targetRole", "address"]],
  create: ["Buat manifest", ["transporter", "processor", "wasteCode", "kg", "file"]],
  "pickup-weight": ["Catat berat pengambilan", ["kg", "file"]],
  pickup: ["Konfirmasi pengambilan", []],
  "received-weight": ["Catat berat penerimaan", ["kg"]],
  receive: ["Konfirmasi penerimaan", []],
  treat: ["Selesaikan pengolahan", ["file"]],
  resolve: ["Selesaikan flag", ["file"]],
};
const fileLabels = { create: "Dokumen manifest", "pickup-weight": "Bukti segel", treat: "Bukti pengolahan", resolve: "Catatan auditor" };
let network;
let current;
let busy = false;
let selection = 0;
let refreshing = false;
let guide;
const sampleDocument = "ChainWaste - dokumen demonstrasi manifest B3";

async function api(path, data) {
  const response = await fetch(path, data === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error);
  return payload;
}

function feedback(message, bad = false) {
  $("feedback").hidden = !message;
  $("feedback").textContent = message;
  $("feedback").classList.toggle("bad", bad);
}

function renderNetwork(state) {
  const health = state?.health ?? "offline";
  const connection = $("connection");
  connection.textContent = {
    online: "RPC Besu terhubung",
    partial: "RPC terhubung · data belum lengkap",
    offline: "RPC Besu tidak terhubung",
  }[health];
  connection.classList.toggle("bad", health !== "online");
  $("validators").textContent = state?.validators?.length ?? "—";
  $("height").textContent = state?.height != null ? format(state.height) : "—";
  $("chain").textContent = state?.height != null ? state.chainId : "—";
  $("count").textContent = state?.count != null ? format(state.count) : "—";
  $("open-network").disabled = !state?.validators;
  $("network-detail").textContent = "Alamat berikut adalah anggota set validator di blockchain. Status proses tiap node dapat dilihat di Docker.";
  $("validator-list").replaceChildren(...(state?.validators ?? []).map((address) => element("li", address)));
  $("submit-action").disabled = busy || health !== "online";
}

async function refreshNetwork() {
  if (refreshing) return;
  refreshing = true;
  try {
    const initial = !network;
    network = await api("/api/state");
    renderNetwork(network);
    if (initial) renderRole();
    if (network.count && network.count !== "0" && !current && !selection && !guide) {
      await selectManifest(network.count, true);
    }
  } catch {
    renderNetwork(null);
    if (!network) renderRole();
  } finally {
    refreshing = false;
  }
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function renderManifest(item) {
  $("manifest-empty").hidden = true;
  $("manifest").hidden = false;
  $("manifest-id").textContent = `Manifest #${item.id}`;
  const bytes = item.wasteCode.slice(2).match(/.{2}/g).map((hex) => parseInt(hex, 16));
  $("waste").textContent = new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/, "");
  $("status").textContent = stages[item.status] ?? item.status;
  $("status").classList.toggle("bad", item.flagged);
  const names = Object.keys(stages);
  $("timeline").replaceChildren(...names.map((name, index) => {
    const step = element("li", stages[name], index <= names.indexOf(item.status) ? "complete" : "");
    if (name === item.status) step.setAttribute("aria-current", "step");
    return step;
  }));
  $("declared").textContent = weight(item.declaredWeightKg);
  $("pickup").textContent = weight(item.pickupWeightKg);
  $("received").textContent = weight(item.receivedWeightKg);
  const pickup = Number(item.pickupWeightKg);
  const received = Number(item.receivedWeightKg);
  const compared = ["Received", "Treated"].includes(item.status);
  const delta = pickup && received ? Math.abs(received - pickup) / pickup * 100 : 0;
  const percent = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
  const maxWeight = Math.max(Number(item.declaredWeightKg), pickup, received, 1);
  for (const [name, value] of Object.entries({ declared: Number(item.declaredWeightKg), pickup, received })) {
    $(`${name}-bar`).max = maxWeight;
    $(`${name}-bar`).value = value;
  }
  $("tolerance").textContent = `Toleransi ${percent.format(Number(item.toleranceBps) / 100)}%`;
  $("received-bar").classList.toggle("alert", compared && delta > Number(item.toleranceBps) / 100);
  $("anomaly").hidden = !item.flagged && !(compared && delta > Number(item.toleranceBps) / 100);
  $("anomaly").textContent = item.flagged
    ? `Flag terbuka. ${compared ? `Selisih ${percent.format(delta)}% · toleransi ${percent.format(Number(item.toleranceBps) / 100)}%. ` : ""}Penyelesaian memerlukan auditor.`
    : `Selisih ${percent.format(delta)}% · flag telah diselesaikan.`;
  $("anomaly").classList.toggle("bad", item.flagged);
}

async function refreshAudit(id) {
  const rows = await api(`/api/manifests/${id}/audit`);
  if (current?.id !== id) return;
  $("audit").replaceChildren(...rows.map((row) => {
    const li = element("li");
    li.append(element("strong", events[row.name] ?? row.name),
      element("small", `Blok ${format(row.block)} · ${new Date(row.at).toLocaleString("id-ID")}`),
      element("code", `Aktor ${row.actor}`), element("code", row.hash));
    return li;
  }));
}

async function selectManifest(id, preserveIndependentForm = false) {
  const request = ++selection;
  try {
    const item = await api(`/api/manifests/${encodeURIComponent(id)}`);
    if (request !== selection) return;
    current = item;
    $("lookup-id").value = item.id;
    $("verification").hidden = true;
    $("verify-submit").disabled = false;
    $("refresh-audit").disabled = false;
    renderManifest(item);
    if (!preserveIndependentForm || !["generator", "regulator"].includes($("role").value)) renderRole();
    renderGuide();
    $("audit").replaceChildren(element("li", "Memuat event…", "empty"));
    await refreshAudit(item.id);
  } catch (error) {
    if (request === selection) feedback(error.message, true);
  }
}

function available(role) {
  if (role === "regulator") return ["register"];
  if (role === "generator") return ["create"];
  if (!current) return [];
  if (role === "auditor") return current.flagged ? ["resolve"] : [];
  if (current.flagged) return [];
  if (role === "oracle" && current.status === "Created" && current.pickupWeightKg === "0") return ["pickup-weight"];
  if (role === "oracle" && current.status === "InTransit" && current.receivedWeightKg === "0") return ["received-weight"];
  if (role === "transporter" && current.status === "Created" && current.pickupWeightKg !== "0") return ["pickup"];
  if (role === "processor" && current.status === "InTransit" && current.receivedWeightKg !== "0") return ["receive"];
  if (role === "processor" && current.status === "Received") return ["treat"];
  return [];
}

function renderRole() {
  const role = $("role").value;
  const address = network?.actors[role];
  $("address").textContent = address ? `${address.slice(0, 8)}…${address.slice(-4)}` : "";
  $("address").title = address ?? "";
  const availableActions = network ? available(role) : [];
  $("action-form").hidden = !availableActions.length;
  $("action-help").hidden = !!availableActions.length;
  $("action-help").textContent = current?.flagged
    ? "Pilih Auditor untuk menutup flag."
    : "Belum ada tindakan untuk akun ini pada tahap sekarang.";
  $("action").replaceChildren(...availableActions.map((action) => {
    const option = element("option", actions[action][0]);
    option.value = action;
    return option;
  }));
  $("action").value = availableActions[0] ?? "";
  renderFields();
}

function renderFields() {
  const action = $("action").value;
  const fields = {
    transporter: ["Alamat pengangkut", "text", network?.actors.transporter],
    processor: ["Alamat pengolah", "text", network?.actors.processor],
    wasteCode: ["Kode limbah", "text", "B3-DEMO"],
    kg: ["Berat (kg)", "number", action === "received-weight" ? (guide?.id === current?.id && guide?.mode === "anomaly" ? "1000" : "9800") : "10000"],
    file: [fileLabels[action], "file", ""],
    address: ["Alamat wallet", "text", ""],
    targetRole: ["Peran tujuan", "select", ""],
  };
  $("fields").replaceChildren(...(actions[action]?.[1] ?? []).flatMap((name) => {
    const [title, type, initial] = fields[name];
    const label = element("label", title);
    label.htmlFor = `field-${name}`;
    const control = element(type === "select" ? "select" : "input");
    control.id = label.htmlFor;
    control.name = name;
    control.required = true;
    if (type === "select") {
      for (const [value, title] of Object.entries(roles).filter(([key]) => key !== "regulator")) {
        const option = element("option", title);
        option.value = value;
        control.append(option);
      }
    } else {
      control.type = type;
      control.value = initial ?? "";
    }
    if (type === "number") { control.min = 1; control.max = 100000; control.step = 1; }
    return [label, control];
  }));
  const file = $("field-file");
  if (file && guide && ((!guide.id && action === "create") || guide.id === current?.id)) {
    const sample = element("button", "Pakai berkas demo", "sample-file");
    sample.type = "button";
    sample.addEventListener("click", () => {
      const content = {
        create: sampleDocument,
        "pickup-weight": "Segel uji ChainWaste",
        resolve: "Auditor meninjau perbedaan berat dalam simulasi ChainWaste.",
        treat: "Pengolahan selesai dalam simulasi ChainWaste.",
      }[action];
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], `chainwaste-${action}.txt`, { type: "text/plain" }));
      file.files = transfer.files;
    });
    $("fields").append(sample);
  }
}

function nextStep() {
  if (!guide.id) return ["Pabrik membuat manifest", "Pilih berkas demo, lalu kirim transaksi pembuatan.", "generator"];
  if (current?.id !== guide.id) return ["Buka manifest demo", "Panduan mengikuti manifest yang dibuat untuk skenario ini.", "manifest"];
  if (current.flagged) return ["Auditor meninjau anomali", "Tunjukkan selisih berat dan flag sebelum auditor mengirim catatan resolusi.", "auditor"];
  if (current.status === "Created" && current.pickupWeightKg === "0") {
    return ["Oracle mencatat pengambilan", "Gunakan 10.000 kg dan berkas segel demo.", "oracle"];
  }
  if (current.status === "Created") return ["Pengangkut menjemput limbah", "Konfirmasi pengambilan untuk mengubah status menjadi Dalam perjalanan.", "transporter"];
  if (current.status === "InTransit" && current.receivedWeightKg === "0") {
    return ["Oracle mencatat penerimaan", `Catat ${guide.mode === "anomaly" ? "1.000" : "9.800"} kg sesuai skenario.`, "oracle"];
  }
  if (current.status === "InTransit") return ["Pengolah menerima limbah", "Konfirmasi penerimaan dan perhatikan apakah kontrak membuka flag.", "processor"];
  if (current.status === "Received") return ["Pengolah mencatat penyelesaian", "Kirim transaksi dengan berkas bukti pengolahan.", "processor"];
  return ["Manifest selesai", "Tunjukkan jejak audit. Gunakan verifikasi untuk membandingkan hash dokumen.", "verify"];
}

function renderGuide() {
  $("guide").hidden = !guide;
  $("verify-demo").hidden = !guide?.sample || guide.id !== current?.id || current?.status !== "Treated";
  if (!guide) return;
  const [title, detail, target] = nextStep();
  $("guide-scenario").textContent = guide.mode === "anomaly" ? "Demo anomali berat" : "Demo alur normal";
  $("guide-title").textContent = title;
  $("guide-detail").textContent = detail;
  $("guide-next").textContent = target === "verify" ? "Ke verifikasi"
    : target === "manifest" ? "Buka manifest" : `Ke akun ${roles[target]}`;
}

function openActions(role) {
  $("role").value = role;
  renderRole();
  $("actions").scrollIntoView({ block: "nearest" });
  $("role").focus({ preventScroll: true });
}

function startDemo(mode) {
  guide = { mode };
  $("demo-dialog").close();
  renderGuide();
  openActions("generator");
}

$("open-demo").addEventListener("click", () => $("demo-dialog").showModal());
$("open-network").addEventListener("click", () => $("network-dialog").showModal());
$("demo-normal").addEventListener("click", () => startDemo("normal"));
$("demo-anomaly").addEventListener("click", () => startDemo("anomaly"));
$("end-demo").addEventListener("click", () => { guide = undefined; renderGuide(); renderRole(); });
$("guide-next").addEventListener("click", () => {
  const target = nextStep()[2];
  if (target === "verify") {
    $("verify-section").scrollIntoView({ block: "nearest" });
    $("verify-file").focus({ preventScroll: true });
  } else if (target === "manifest") {
    selectManifest(guide.id);
  } else {
    openActions(target);
  }
});

function base64(file) {
  if (file.size > 1_048_576) throw new Error("Batas file 1 MiB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("File tidak bisa dibaca."));
    reader.readAsDataURL(file);
  });
}

$("role").addEventListener("change", renderRole);
$("action").addEventListener("change", renderFields);
$("lookup").addEventListener("submit", (event) => {
  event.preventDefault();
  feedback("");
  selectManifest($("lookup-id").value);
});
$("refresh-audit").addEventListener("click", () => {
  if (current) refreshAudit(current.id).catch((error) => feedback(error.message, true));
});
$("action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || network?.health !== "online") return;
  const activeGuide = guide;
  const action = $("action").value;
  const role = $("role").value;
  const data = new FormData(event.target);
  busy = true;
  $("submit-action").disabled = true;
  $("role").disabled = true;
  $("receipt").hidden = true;
  feedback("Mengirim transaksi dan menunggu konfirmasi blok…");
  try {
    const payload = Object.fromEntries(data);
    if (data.has("file")) payload.file = await base64(data.get("file"));
    const original = activeGuide && !activeGuide.id && action === "create"
      && await data.get("file").text() === sampleDocument;
    const receipt = await api(`/api/actions/${action}`, { ...payload, role, id: current?.id });
    $("receipt").textContent = `Blok ${format(receipt.block)} · ${format(receipt.gasUsed)} gas\n${receipt.hash}`;
    $("receipt").hidden = false;
    feedback(receipt.events.map(({ name }) => events[name] ?? name).join(" · ") || "Transaksi tercatat.");
    if (activeGuide && activeGuide === guide && !activeGuide.id && action === "create") {
      activeGuide.id = receipt.id;
      activeGuide.sample = original;
    }
    if (receipt.id) await selectManifest(receipt.id);
    await refreshNetwork();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    $("role").disabled = false;
    $("submit-action").disabled = network?.health !== "online" || $("connection").classList.contains("bad");
  }
});
async function verifyFile(file) {
  if (!current || !file) return;
  const id = current.id;
  $("verify-submit").disabled = true;
  $("verification").hidden = true;
  try {
    const result = await api("/api/verify", { id, file: await base64(file) });
    if (current.id !== id) return;
    $("verification").textContent = `${result.matches ? "Hash cocok" : "Hash berbeda"}\nOn-chain: ${result.expected}\nFile: ${result.actual}`;
    $("verification").classList.toggle("bad", !result.matches);
    $("verification").hidden = false;
  } catch (error) {
    feedback(error.message, true);
  } finally {
    $("verify-submit").disabled = !current;
  }
}
$("verify").addEventListener("submit", (event) => {
  event.preventDefault();
  verifyFile($("verify-file").files[0]);
});
$("verify-original").addEventListener("click", () => verifyFile(new Blob([sampleDocument])));
$("verify-changed").addEventListener("click", () => verifyFile(new Blob([`${sampleDocument} (diubah)`])));

renderRole();
refreshNetwork();
setInterval(refreshNetwork, 3_000);
