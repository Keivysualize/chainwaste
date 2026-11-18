# Hasil pengujian ChainWaste

Pengujian pada 18 November 2026 memakai Besu 26.2.0, chain ID 31370, target
EVM London, tujuh validator dan satu RPC. Bukti di bawah berasal dari output
PowerShell dan laporan JSON yang dihasilkan skrip eksperimen.

## Benchmark transaksi

Laporan `benchmark-2026-11-18T08-39-49.645Z.json` mencatat enam transaksi
berurutan untuk masing-masing manifest #2 sampai #6. Kelimanya mencapai
`Treated`. Ringkasan berikut memakai lima sampel per operasi.

| Operasi | Rata-rata gasUsed | Rata-rata waktu hingga receipt (ms) |
| --- | ---: | ---: |
| createManifest | 267.530 | 4.200 |
| recordPickupWeight | 81.662 | 4.191 |
| confirmPickup | 60.183 | 4.207 |
| recordReceivedWeight | 58.796 | 4.210 |
| confirmReceipt | 48.011 | 4.206 |
| markTreated | 65.305 | 4.199 |

Dari 30 sampel, waktu minimum 4.140 ms, rata-rata 4.202 ms, dan maksimum
4.266 ms. Timer dimulai sebelum pemanggilan transaksi dan berakhir saat
receipt terbaca, sehingga mencakup waktu sisi klien termasuk polling.
Semua sampel membayar 0 wei pada konfigurasi free gas.

## Uji quorum QBFT

Laporan `quorum-2026-11-18T08-41-50.858Z.json` memakai genesis yang sama
dengan benchmark.

| Skenario | Blok awal | Blok akhir | Hasil |
| --- | ---: | ---: | --- |
| Semua validator aktif | 217 | 218 | Blok bertambah |
| 1 validator dihentikan | 219 | 220 | Blok bertambah |
| 2 validator dihentikan | 221 | 222 | Blok bertambah |
| 3 validator dihentikan | 222 | 222 | Tetap selama 25 detik |
| Validator dipulihkan | 222 | 223 | Blok baru teramati setelah sekitar 71 detik |

Hasil sesuai dengan quorum lima dari tujuh pada konfigurasi demo. Penghentian
container mensimulasikan crash fault.

## CLI di Besu

| Skenario | Bukti |
| --- | --- |
| Manifest #7, berat 10.000 menjadi 9.800 kg | Dibuat di blok 693, mencapai `Treated` di blok 706, flag tetap tertutup, audit trail tampil, hash file asli cocok. |
| Manifest #8, berat 10.000 menjadi 1.000 kg | `AnomalyDetected` pada blok 780, dan percobaan pengolahan ditolak dengan `FlagStillOpen`. Auditor memicu `FlagResolved` pada blok 783. Pengolahan selesai pada blok 786 dengan flag tertutup. |
| File manifest diubah | `matches: false` dan exit code 1 pada manifest #8. |

Untuk reproduksi dari root repo, jalankan `npx.cmd hardhat test`, ikuti
[panduan jaringan](../network/README.md), lalu jalankan
`node scripts/experiments/benchmark.mjs` dan `node scripts/experiments/quorum.mjs`
secara berurutan. Uji quorum menghentikan validator pada jaringan demo selama
observasi, jadi jalankan saat transaksi lain sedang tidak diproses. Skenario
CLI tersedia di [panduan CLI](../cli/README.md).
