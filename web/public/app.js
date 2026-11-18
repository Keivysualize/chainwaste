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

async function refreshNetwork() {
  try {
    const initial = !network;
    network = await api("/api/state");
    $("connection").textContent = "RPC Besu terhubung";
    $("connection").classList.remove("bad");
    $("validators").textContent = network.validators.length;
    $("validators").title = network.validators.join("\n");
    $("height").textContent = format(network.height);
    $("chain").textContent = network.chainId;
    $("count").textContent = format(network.count);
    if (initial) {
      renderRole();
      if (network.count !== "0" && !current && !selection) await selectManifest(network.count);
    }
  } catch {
    $("connection").textContent = "RPC Besu tidak terhubung";
    $("connection").classList.add("bad");
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
  $("timeline").replaceChildren(...names.map((name, index) => element("li", stages[name],
    index <= names.indexOf(item.status) ? "complete" : "")));
  $("declared").textContent = weight(item.declaredWeightKg);
  $("pickup").textContent = weight(item.pickupWeightKg);
  $("received").textContent = weight(item.receivedWeightKg);
  const pickup = Number(item.pickupWeightKg);
  const received = Number(item.receivedWeightKg);
  const compared = ["Received", "Treated"].includes(item.status);
  const delta = pickup && received ? Math.abs(received - pickup) / pickup * 100 : 0;
  const percent = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
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

async function selectManifest(id) {
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
    renderRole();
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
  $("action-role").textContent = roles[role];
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
  renderFields();
}

function renderFields() {
  const action = $("action").value;
  const fields = {
    transporter: ["Alamat pengangkut", "text", network?.actors.transporter],
    processor: ["Alamat pengolah", "text", network?.actors.processor],
    wasteCode: ["Kode limbah", "text", "B3-DEMO"],
    kg: ["Berat (kg)", "number", action === "received-weight" ? "9800" : "10000"],
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
}

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
  if (busy) return;
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
    const receipt = await api(`/api/actions/${action}`, { ...payload, role, id: current?.id });
    $("receipt").textContent = `Blok ${format(receipt.block)} · ${format(receipt.gasUsed)} gas\n${receipt.hash}`;
    $("receipt").hidden = false;
    feedback(receipt.events.map(({ name }) => events[name] ?? name).join(" · ") || "Transaksi tercatat.");
    if (receipt.id) await selectManifest(receipt.id);
    await refreshNetwork();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    $("role").disabled = false;
    $("submit-action").disabled = false;
  }
});
$("verify").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current) return;
  const id = current.id;
  $("verify-submit").disabled = true;
  $("verification").hidden = true;
  try {
    const result = await api("/api/verify", { id, file: await base64($("verify-file").files[0]) });
    if (current.id !== id) return;
    $("verification").textContent = `${result.matches ? "Hash cocok" : "Hash berbeda"}\nOn-chain: ${result.expected}\nFile: ${result.actual}`;
    $("verification").classList.toggle("bad", !result.matches);
    $("verification").hidden = false;
  } catch (error) {
    feedback(error.message, true);
  } finally {
    $("verify-submit").disabled = !current;
  }
});

renderRole();
refreshNetwork();
setInterval(refreshNetwork, 3_000);
