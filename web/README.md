# Dashboard ChainWaste

Dashboard ini memakai HTML, CSS, JavaScript browser, dan API Node.js dengan
ethers.js. Smart contract, chain Besu, dan CLI memakai deployment yang sama.

## Jalankan dari PowerShell

Buka Docker Desktop. Dari root repo:

```powershell
npm.cmd ci
node network/start.mjs
npx.cmd hardhat build
node network/deploy.mjs
node web/server.mjs
```

Kalau Besu dan deployment sudah aktif, cukup jalankan baris terakhir.
Biarkan terminal server terbuka dan buka **http://127.0.0.1:4173/**.
Gunakan alamat tersebut persis, karena server memeriksa host dan origin.
Hentikan server dengan Ctrl+C. Port 4173 dipakai dashboard dan port 8545
dipakai RPC Besu.

## Demo web

1. Pastikan jumlah validator dan nomor blok tampil. Jumlah validator menunjukkan
   anggota set QBFT. Untuk melihat container mana yang sedang berjalan, gunakan
   `docker compose -f network/generated/compose.json ps`.
2. Pilih **Pabrik penghasil**, pilih file manifest, lalu kirim transaksi
   pembuatan. Pengangkut, pengolah, dan berat 10.000 kg terisi untuk demo.
3. Pilih **Oracle timbangan**, catat 10.000 kg, dan unggah file bukti segel.
   Pilih **Pengangkut** dan konfirmasi pengambilan.
4. Kembali ke **Oracle timbangan** dan catat berat penerimaan. Pilih **Pengolah**
   dan konfirmasi penerimaan. Untuk skenario normal pakai 9.800 kg, lalu
   unggah bukti pengolahan untuk menyelesaikan.
5. Buat manifest baru untuk skenario anomali dan catat penerimaan 1.000 kg.
   Pengolahan tertahan. Pilih **Auditor**, unggah catatan, dan selesaikan flag.
   Kembali ke **Pengolah** untuk mengirim bukti pengolahan.
6. Di **Jejak audit**, tunjukkan event, aktor, nomor blok, dan hash transaksi.
   Di **Verifikasi dokumen**, pilih file asli dan salinan yang isinya berubah.

Gunakan file demo sederhana berukuran maksimal 1 MiB. Aplikasi menghitung hash
byte file dalam proses API. Besu menerima hash dan data transaksi, sementara
isi file tidak disimpan oleh aplikasi.

## Batas penggunaan

Dashboard merupakan alat demo lokal. API mengikat ke loopback dan memilih
wallet demo berdasarkan aksi dan peran. Private key dibaca dari
`network/generated/accounts.json` oleh proses Node dan tidak dikirim ke browser.
Pengguna yang memiliki akses ke proses demo di laptop dapat memilih peran demo.
Gunakan hanya akun dan data simulasi. CLI tetap tersedia di
[panduan CLI](../cli/README.md).

## Mode demo dan alur presentasi

Klik **Mode demo**, lalu pilih **Alur normal** (10.000 → 9.800 kg) atau
**Anomali berat** (10.000 → 1.000 kg). Gunakan tombol pada panel panduan untuk
berpindah ke akun yang dibutuhkan. **Pakai berkas demo** mengisi input file
setempat. Klik **Kirim transaksi** di setiap tahap dan tunggu receipt sebelum
berpindah. Setiap skenario membuat manifest baru.

| Bagian | Yang ditunjukkan | Narasi |
| --- | --- | --- |
| Jaringan | Nomor blok bertambah dan **Lihat set validator** | “Besu menjalankan QBFT. Tujuh alamat ini terdaftar sebagai validator dan blok memerlukan lima suara.” |
| Manifest normal | Alur dari pembuatan hingga **Diolah** | “Selisih 2% ada di bawah ambang 5%, sehingga pengolahan dapat dilanjutkan.” |
| Manifest anomali | Penerimaan 1.000 kg, flag terbuka, resolusi auditor | “Kontrak mendeteksi selisih 90%. Auditor mencatat hasil tinjauan sebelum pengolah dapat menyelesaikan manifest.” |
| Integritas | **Ke verifikasi**, **Cek contoh asli**, **Cek contoh diubah**, lalu jejak audit | “Dokumen asli cocok dengan hash on-chain. Perubahan isi menghasilkan hash berbeda. Event dan receipt mencatat jejak tindakan.” |

Tombol contoh verifikasi muncul setelah manifest demo selesai dan memakai
dokumen contoh bawaan. Untuk dokumen sendiri, gunakan pemilih file. Jika waktu
presentasi singkat, tampilkan satu manifest normal yang sudah selesai dan
jalankan alur anomali secara live. Bukti uji quorum bisa ditunjukkan terpisah
setelah transaksi demo, karena eksperimen menghentikan validator sementara.

Jika dashboard menampilkan **RPC terhubung · data belum lengkap**, salah satu
pembacaan set validator atau data kontrak gagal walaupun nomor blok tersedia.
Dashboard mengosongkan metrik yang belum bisa dibaca. Untuk status node yang
berjalan, cek `docker compose -f network/generated/compose.json ps`.
