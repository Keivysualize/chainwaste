# ChainWaste di Besu QBFT

Lingkungan ini ditujukan untuk demo lokal. Tujuh validator menggunakan pemilihan
berdasarkan header blok, dengan quorum lima dari tujuh untuk blok. Satu node
tambahan menyajikan RPC tanpa ikut voting blok. Chain ID 31370, target EVM London,
block period 2 detik, round timeout awal 4 detik, dan epoch 30.000 blok.
Besu 26.2.0 dipin agar versi semua node sama.

## Menjalankan dari root repo

Buka Docker Desktop dengan mode Linux containers, lalu jalankan di PowerShell:

```powershell
npm.cmd ci
node network/start.mjs
npx.cmd hardhat build
node network/deploy.mjs
```

Start membuat genesis dan konfigurasi Compose saat pertama kali dijalankan.
Deployment menunggu nomor blok naik dan mencocokkan ketujuh alamat validator
dengan genesis. Setelah itu, skrip mendeploy kedua kontrak, mendaftarkan aktor,
dan membuat satu manifest contoh dalam status Created. Jalankan sekali pada satu
waktu. Untuk menjalankan ulang, skrip memakai kembali kontrak dan contoh yang
tercatat. Jika transaksi deploy sempat terkirim tetapi belum sempat disimpan,
cek receipt sebelum menjalankan ulang.

`network/generated/deployment.json` memuat RPC, chain ID, alamat kontrak, alamat
akun demo, dan ID manifest awal. `network/generated/accounts.json` memuat private
key uji lokal. Pakai file kedua hanya di laptop yang menjalankan jaringan.
Jangan commit atau membagikan isi private key. Saat Jonathan menjalankan clone
sendiri, ia bisa menghasilkan akun dan genesis baru dengan langkah yang sama.

## Pemeriksaan dan penghentian

```powershell
docker compose -f network/generated/compose.json ps
docker compose -f network/generated/compose.json logs --tail 60 rpc val-regulator
docker compose -f network/generated/compose.json stop
```

Jalankan kembali `node network/start.mjs` untuk melanjutkan chain yang sama.
Port 8545 harus kosong sebelum start. Subnet Compose menggunakan
172.30.74.0/24. Jika ada konflik subnet, hentikan proses start dan cek jaringan
Docker yang sudah ada. Pertahankan genesis, key node, dan volume sebagai satu set.

## Batas implementasi

RPC hanya tersedia melalui 127.0.0.1:8545. Peer memakai alamat statis pada jaringan
Docker khusus dengan discovery dimatikan. Belum ada allowlist node/account atau
rate limiting. Model free gas memakai base fee dan minimum gas price nol. Biaya
transaksi nol tetap menghasilkan gasUsed yang bisa diukur.

Besu memakai kunci node untuk konsensus. ValidatorGovernance memakai dompet
pemungutan suara terpisah yang mewakili institusi yang sama. Keputusan kontrak
direkam on-chain dan tidak mengubah set validator Besu. Akun oracle mensimulasikan
timbangan. Dokumen contoh untuk hash manifest seed adalah byte UTF-8 persis dari
string `chainwaste-demo-manifest-v1`.

Referensi: [QBFT](https://docs.besu-eth.org/private-networks/how-to/configure/consensus/qbft),
[free gas](https://docs.besu-eth.org/private-networks/how-to/configure/free-gas),
dan [opsi Besu](https://docs.besu-eth.org/public-networks/reference/options).
