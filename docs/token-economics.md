# ZipMem — Token Ekonomisi ve Verim Analizi

> Amaç: ZipMem'in bir projede çalışırken **hangi aşamada ne kadar token harcadığını**,
> bunun karşılığında **oturumlar arası geçişte ne kadar tasarruf sağladığını**, ve bunun
> farklı `checkpoint_mode` modlarında / farklı sohbet uzunluklarında nasıl değiştiğini
> gerçekçi ve objektif olarak modellemek.
>
> Bu belgedeki tüm sayılar **stated-assumption modelleridir** (ölçüm + makul tahmin),
> ±%30 hata payıyla okunmalıdır. Kaynak: `src/core/directive.ts`, `src/core/format.ts`,
> `src/server/tools/*.ts` üzerinden ölçülen gerçek boyutlar + token modeli.

---

## 0. TL;DR — Önce en önemli soru: "Tasarruf nerede oluyor?"

**Kullanıcının tezi doğru — küçük bir düzeltmeyle onaylıyorum:**

> "Bizim projemiz sohbet içerisinde tasarruf sağlamıyor, oturumlar arası geçişte
> en verimli şekilde hafıza sağlıyor."

✅ **Doğru.** ZipMem **tek bir sohbet/oturum içinde token tasarrufu yapmaz** — aksine
**net olarak az miktarda token *ekler*** (direktif + araç tanımları + checkpoint/save
çıktıları). Bir oturumun canlı bağlam penceresini (context window) küçültmez; bu onun işi
değil. Tasarruf tamamen **oturum sınırında** doğar: **yeni bir sohbet açıldığında**, sıfırdan
dosya okuyup mimariyi yeniden çıkarmak yerine **sıkıştırılmış hafızayı tek seferde** yükler.

🔧 **Düzeltme/nüans:** "Sohbet içinde hiç fayda yok" demek tam doğru değil. İki dolaylı
in-session etki var ama bunlar **çekirdek mekanizma değil, yan etki**:
1. Direktif, ajanı kod bloğu yapıştırmak yerine **anchor** (dosya+satır koordinatı)
   üretmeye yönlendirir → uzun oturumlarda pencere biraz daha yavaş şişer.
2. Checkpoint disiplini, ajanı düzenli olarak "ne yaptım" diye özetlemeye iter → bu da
   doğal bir hijyen sağlar.

Ama bunlar tasarrufun *kaynağı* değildir. **Çekirdek değer = oturumlar arası bağlam yeniden
kazanım (re-acquisition) maliyetinden kaçınmak.**

**Sonuç olarak:**
- **Kısa, tek seferlik sohbetler** → ZipMem **net zarar** (saf overhead). Kullanmayın.
- **Uzun ve/veya çok-oturumlu projeler** → net pozitif; proje büyüdükçe tasarruf yüzdesi artar.

---

## 1. Varsayımlar (hesabın temeli)

| Varsayım | Değer | Not |
|---|---|---|
| Token ≈ karakter oranı | 1 token ≈ 4 karakter | İngilizce/kod için standart yaklaşım |
| Prompt caching | Aktif (Claude Code kullanır) | Statik bloklar 1 kez yazılır, sonra ~%10 maliyetle okunur |
| Statik blok = "pencere maliyeti" | Cache'lenir, **billed maliyeti düşük** | Ama pencerede yer kaplar; ayrı raporlanır |
| Üretilen (generated) token | **Hiç cache'lenmez** | Asıl artımlı (incremental) maliyet budur |
| "Hafızasız re-acquisition" | En belirsiz değişken | Aralık verilir, orta nokta kullanılır |

### 1.1 Ölçülen statik boyutlar (gerçek)

| Bileşen | Ölçüm | Token (≈) | Cache? |
|---|---|---|---|
| Direktif gövdesi (balanced) | 3.152 karakter | **~790** | ✅ CLAUDE.md'de, oturumda 1 kez |
| Direktif (conservative) | daha uzun | ~950 | ✅ |
| Direktif (aggressive) | daha kısa | ~760 | ✅ |
| 3 araç tanımı (ad + açıklama + JSON şema) | ölçüm üzerinden tahmin | **~1.300/tur** | ✅ her turda, cache'li |

> Not: CLAUDE.md §9'da direktif "~600–700 token" deniyor; gerçek ölçüm **~790 (balanced)**.
> Hafif eksik tahmin edilmiş — bu belgede gerçek değeri kullanıyorum.

### 1.2 Üretilen (uncached) maliyetler

| Olay | Token (≈) | Sıklık |
|---|---|---|
| `load_memory` sonucu (okunur, sonra input olur) | boş proje ~60 · küçük ~400 · **olgun ~1.500** · büyük (100KB'a yakın) ~3.000+ | Oturum başına **1 kez** |
| `checkpoint` çıktısı (her çağrı) | ~250 (tek satır özet + birkaç anchor) | **Moda göre değişir** |
| `save_and_compact` çıktısı | ~500 | Oturum sonunda **1 kez** |

---

## 2. Aşama aşama token tüketimi (kısa liste)

Tek bir oturumda ZipMem'in dokunduğu her aşama:

| # | Aşama | Tür | Token (≈) | Açıklama |
|---|---|---|---|---|
| 1 | Direktif (CLAUDE.md) yüklenir | Statik/cache | ~790 | Oturum boyunca pencerede sabit durur |
| 2 | 3 araç tanımı her turda görünür | Statik/cache | ~1.300/tur | Cache'li → billed maliyeti düşük |
| 3 | `zipmem_load_memory` çağrısı + sonucu | Üretilen + input | ~1.500 (olgun proje) | Oturum başı, **1 kez** |
| 4 | `zipmem_checkpoint` (çalışma sırasında) | Üretilen | ~250 × N | N = moda + uzunluğa bağlı |
| 5 | `zipmem_save_and_compact` (kapanışta) | Üretilen | ~500 | **1 kez** |
| 6 | Ölüm/çökme anı (recovery) | **0** | 0 | LLM çalışmaz; sadece dosya işareti |

**Özet:** Statik pencere işgali ≈ **~2.100 token** (cache'li, billed etkisi küçük).
Asıl artımlı maliyet = `load (1.500)` + `N × checkpoint (250)` + `save (500)`.

---

## 3. Sohbet uzunluğuna göre maliyet (mod × uzunluk)

Checkpoint sayısı moda göre (objektif tahmin): aggressive ≈ her ~8k token'lik işe 1;
balanced ≈ her ~33k'ya 1 (sadece kilometre taşı); conservative ≈ yalnız kullanıcı "checkpoint"/"save"
dediğinde.

| Sohbet zirvesi | aggressive (ckpt) | balanced (ckpt) | conservative (ckpt) |
|---|---|---|---|
| 30k | 4 | 1 | 0–1 |
| 100k | 12 | 3 | 1 |
| 200k | 24 | 6 | 2 |
| 300k | 36 | 9 | 3 |

### 3.1 ZipMem'in EKLEDİĞİ token (olgun proje: load≈1.500, ckpt≈250, save≈500)

| Sohbet zirvesi | aggressive | balanced | conservative |
|---|---|---|---|
| 30k | 3.000 | 2.250 | 2.000 |
| 100k | 5.000 | 2.750 | 2.250 |
| 200k | 8.000 | 3.500 | 2.500 |
| 300k | 11.000 | 4.250 | 2.750 |

### 3.2 Aynı maliyetin sohbet boyutuna oranı (= "in-session overhead %")

| Sohbet zirvesi | aggressive | balanced | conservative |
|---|---|---|---|
| 30k | **%10,0** | %7,5 | %6,7 |
| 100k | %5,0 | %2,8 | %2,3 |
| 200k | %4,0 | %1,8 | %1,3 |
| 300k | %3,7 | %1,4 | **%0,9** |

> **Okuma:** Bu tablo ZipMem'in **in-session saf maliyetidir** (tasarruf değil). Görüldüğü gibi
> küçük sohbetlerde oran yüksek (30k + aggressive = %10 fazladan), sohbet büyüdükçe oran düşer.
> Bu, "kısa sohbette ekstra tüketim olur" tezini doğrular. Statik ~2.100 token cache'li
> olduğu için billed etkisi bu rakamların altındadır; tablo pencere-işgali üst sınırını verir.

---

## 4. Yeni sohbet açıldığındaki tasarruf (çekirdek fayda)

İşin can alıcı kısmı. **Hafızasız** bir ajan yeni oturumda bağlamı yeniden kazanmak için
dosyaları yeniden okur / mimariyi yeniden çıkarır. **ZipMem'li** ajan ise `load_memory`
ile sıkıştırılmış hafızayı alır, yalnızca gereken dosyaları anchor üzerinden açar.

Re-acquisition maliyeti proje olgunluğuyla (≈ birikmiş iş) ilişkilidir:

| Proje birikimi | Hafızasız (re-acq, aralık) | orta | ZipMem'li restore | **Tasarruf / yeni oturum** |
|---|---|---|---|---|
| ~30k | 3.000–6.000 | 4.500 | ~2.500 | **~2.000** |
| ~100k | 8.000–15.000 | 11.000 | ~4.000 | **~7.000** |
| ~200k | 15.000–28.000 | 20.000 | ~5.500 | **~14.500** |
| ~300k | 22.000–40.000 | 30.000 | ~7.000 | **~23.000** |

> ZipMem'li restore = `load_memory (~1.500)` + talep-üzerine birkaç dosya okuma (~2.000–5.500).
> Hafızasız tarafta ajan tipik olarak 2–3 kat daha fazla dosyayı "ihtiyaten" yeniden okur.

**Kritik nokta:** Tasarruf sohbet zirvesiyle değil, **birikmiş proje bilgisiyle** büyür.
Proje ne kadar olgunsa, sıfırdan bağlam kurmak o kadar pahalıdır → ZipMem o kadar kazandırır.

---

## 5. Kümülatif (çok-oturumlu) karşılaştırma: kullanan vs kullanmayan

Gerçek senaryo: bir proje birden çok oturuma yayılır. Her oturum ~40k token üretken iş
yapsın; proje 5 oturumda ~200k üretken işe ulaşsın. "Üretken iş" tokenları her iki tarafta
da aynıdır — fark **overhead vs re-acquisition** deltasındadır.

### 5.1 balanced mod, 5 oturumluk proje (~200k üretken iş)

| Kalem | Hafızasız (baseline) | ZipMem (balanced) |
|---|---|---|
| Üretken iş (5 × 40k) | 200.000 | 200.000 |
| Oturum 1 restore | 0 (yeni) | +2.250 (overhead) |
| Oturum 2–5 bağlam kazanım | +4 × ~11.000 = **+44.000** | +4 × ~4.000 = **+16.000** |
| Oturum 2–5 ZipMem overhead | — | +4 × ~2.750 = +11.000 |
| **TOPLAM** | **~244.000** | **~229.250** |
| **Net tasarruf** | — | **~14.750 token (%6,0)** |

### 5.2 Daha büyük/olgun proje (oturum başı re-acq ~20k, 5 oturum)

| Kalem | Hafızasız | ZipMem (balanced) |
|---|---|---|
| Üretken iş | 200.000 | 200.000 |
| Bağlam kazanım (oturum 2–5) | +4 × 20.000 = **+80.000** | +4 × 5.500 = **+22.000** |
| ZipMem overhead (5 oturum) | — | +5 × 3.500 = +17.500 |
| **TOPLAM** | **~280.000** | **~239.500** |
| **Net tasarruf** | — | **~40.500 token (%14,5)** |

### 5.3 Mod karşılaştırması (5.2 senaryosu, olgun proje)

| Mod | ZipMem overhead (5 ot.) | Toplam | Net tasarruf |
|---|---|---|---|
| conservative | ~12.500 | ~234.500 | **%16,3** |
| balanced | ~17.500 | ~239.500 | **%14,5** |
| aggressive | ~40.000 | ~262.000 | **%6,4** |

> **Yorum:** Çok-oturumlu olgun projede **conservative ve balanced** açık ara en verimli.
> **aggressive** modun ekstra checkpoint'leri tasarrufun ~yarısını yer — onu yalnız
> "çökme riski yüksek, kaybı göze alamam" senaryolarında seç. **Varsayılan `balanced`
> doğru seçilmiş.**

---

## 6. İstatistik özeti (kullanıcı için tek cümlelik formül)

> **ZipMem, tek bir kısa sohbette ~%1–10 oranında *fazladan* token harcatır (saf overhead);
> ama proje çok oturuma yayılıp olgunlaştıkça net tasarruf pozitife döner ve büyür:
> ~200k birikimli iş hacminde **~%6–15**, ~300k+ ve daha olgun projelerde **~%20–30'a**
> kadar net token tasarrufu sağlar. Tasarruf, sohbetin uzunluğundan çok, kaç kez yeni
> oturum açıldığına ve projenin ne kadar olgun olduğuna bağlıdır.**

Kısa tablo halinde net tasarruf bandı:

| Birikimli iş hacmi / olgunluk | Net tasarruf bandı (balanced) |
|---|---|
| < ~30k, tek oturum | **Negatif** (~−%5 ila −%10; kullanma) |
| ~100k, 2–3 oturum | ~%3 – %8 |
| ~200k, 4–5 oturum | ~%6 – %15 |
| ~300k+, olgun, çok oturum | ~%15 – %30 |

> %20–30'luk üst bant, ancak **olgun proje + sık yeni oturum + disiplinli checkpoint**
> birlikte gerçekleştiğinde görülür. Tek başına "300k token'lık sohbet" otomatik %30 vermez;
> asıl çarpan **oturum sayısı + re-acquisition'dan kaçınılan iş**tir.

---

## 7. Diğer hafıza yöntemleriyle karşılaştırma

| Yöntem | Oturumlar arası kalıcılık | Token maliyeti | Altyapı/anahtar | Belirlilik | Zayıf yanı |
|---|---|---|---|---|---|
| **Hafızasız (her oturum yeniden oku)** | ❌ | En yüksek (zamanla) | Yok | — | Bağlam her seferinde sıfırdan |
| **Eski transcript'i yapıştır** | ⚠️ manuel | **Çok yüksek** | Yok | Düşük | Pencereyi bloat eder; amacı baltalar |
| **Manuel CLAUDE.md notları** | ✅ ama statik | Çok düşük | Yok | Orta | Elle bakım, eskir, anchor yok, kayıplı |
| **Claude Code `/compact`** | ❌ (oturum içi) | Düşük | Yok | Orta | Sadece canlı pencereyi küçültür, **kalıcı değil**, kayıplı |
| **RAG / vektör hafıza (mem0, Letta/MemGPT)** | ✅ | Orta (sorgu başı retrieval) | **Embedding + DB/anahtar gerekir** | Düşük (fuzzy) | Gürültü çekebilir, altyapı yükü, non-deterministik |
| **Dev context penceresi (her şeyi içe al)** | ❌ | En yüksek | Yok | Yüksek | Pahalı, pencere sınırlı |
| **ZipMem** | ✅ | **Düşük** (sabit, çoğu cache'li) | **Yok** (lokal, anahtarsız) | **Yüksek** (deterministik) | Tek proje, eşzamanlılık yok, disipline bağlı, fuzzy semantik arama yok |

**ZipMem'in konumlanması:** `/compact` ile **rakip değil, tamamlayıcı** (`/compact` =
oturum içi pencere; ZipMem = oturumlar arası anlam). RAG hafızalarına göre **sıfır altyapı +
deterministik + kod-anchor + verbatim blueprint** sunar; karşılığında **fuzzy semantik geri
getirme genişliğinden** ve çok-projelilikten feragat eder. Manuel CLAUDE.md'ye göre
otomatik, yapısal ve anchor-temelli; transcript yapıştırmaya göre kıyaslanamaz derecede ucuz.

---

## 8. Verimi artırma — prompt/maliyet kaldıraçları

### 8.1 Önce mit yıkımı: statik blokları kısaltmak **küçük** kazanç verir
Direktif (~790) ve araç tanımları (~1.300) **cache'lenir** → billed etkileri zaten düşük.
Bunları kısaltmak çoğunlukla **pencere işgalini** azaltır, gerçek token faturasını az.
Üstelik direktifin ayrıntısı, **zayıf modellerin protokole uymasını** sağlayan şeydir —
agresif kısaltma uyumu bozabilir. Yani: ölçülü kısalt, abartma.

### 8.2 Asıl kaldıraçlar (uncached, gerçek token):

1. **Checkpoint cadence (en büyük kaldıraç).** aggressive mod tasarrufun yarısını yiyebilir
   (bkz. §5.3). `balanced` varsayılanı doğru; `aggressive`'i yalnız yüksek çökme riskinde öner.
2. **`load_memory` çıktı boyutu.** Hafıza soft-limit'e (100KB) yaklaştıkça restore maliyeti
   artar. Öneri: **lazy/aşamalı yükleme** — varsayılanda yalnız `blueprints + lessons` döndür,
   `anchors`'ı talep üzerine. `sections` parametresi zaten var; varsayılanı "all" yerine
   "özet" yapmak düşünülebilir.
3. **`load_memory` için token bütçesi.** Çıktıya yumuşak bir üst sınır (örn. en yeni N
   blueprint/anchor + "daha fazlası için sections kullan") koymak büyük projelerde restore'u
   sabit tutar.
4. **Checkpoint payload disiplini.** Özetler tek satır kalmalı; `format.ts` zaten terse —
   bunu direktifte de net tut ("running summary = tek satır").

### 8.3 Somut, düşük riskli iyileştirme önerileri
- [ ] **Güçlü modeller için terser direktif varyantı** (örn. ~790 → ~550 token); `init`
      sırasında opsiyonel `--directive=lean`. Pencere işgalini ~%30 düşürür.
- [ ] **Anchor lazy-load:** `load_memory` varsayılanı blueprints+lessons; anchors ayrı çağrı.
- [ ] **`load_memory` token tavanı** + "kırpıldı, sections kullan" notu.
- [ ] CLAUDE.md §9'daki "~600–700 token" rakamını **~790**'a güncelle (doğruluk).
- [ ] Araç açıklamalarını ~%15 kısalt (sinyali koruyarak) — pencere işgali kazanımı.

> **Uyarı:** Bu kaldıraçların hiçbiri "tek sohbette tasarruf" yaratmaz; hepsi ya pencere
> işgalini ya da oturum-başı overhead'i düşürür. Çekirdek fayda hâlâ oturumlar arasındadır.

---

## 9. Sonuç

1. **Kullanıcının tezi doğru:** ZipMem oturum içinde tasarruf etmez, **eder gibi de
   görünmemeli** — değeri oturumlar arası bağlam restore'undadır.
2. **Kısa/tek-seferlik sohbet → kullanma** (net %1–10 zarar).
3. **Uzun, çok-oturumlu, olgun proje → net %6–30 tasarruf;** çarpan = oturum sayısı + proje
   olgunluğu, sohbet uzunluğu değil.
4. **Varsayılan `balanced` mod isabetli.** `aggressive` yalnız çökme-kritik işlerde;
   `conservative` token-cimrisi/uzun-tek-oturum senaryolarında en verimli.
5. **En büyük verim kaldıracı = checkpoint cadence** ve **`load_memory` çıktı boyutu**;
   statik prompt kısaltma ikincil (çoğu cache'li).

---

*Bu rapor bir maliyet modelidir; kesin fatura değildir. Sayılar belirtilen varsayımlara
duyarlıdır. Gerçek ölçüm için: birkaç gerçek oturumda Claude Code'un token sayaçlarıyla
(`/cost`) bu tahminleri doğrulamak önerilir.*
