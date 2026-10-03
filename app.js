/* =====================================================================
   app.js — Tabungan Fauzan & Hafizha (versi GitHub Pages)
   =====================================================================
   Menggantikan app.py (Flask). Semua data disimpan di Google
   Spreadsheet & Google Drive lewat Apps Script (Code.gs); halaman ini
   hanya menampilkan dan mengirim data. Logika (total, sisa, persen,
   format Rupiah, nama penabung, pesan-pesan) sama dengan versi Flask.
   ===================================================================== */
(function () {
  "use strict";

  var CFG = window.TABUNGAN_CONFIG || {};
  var KEY_PIN = "tabungan_pin_v1";
  var KEY_CACHE = "tabungan_cache_v1";
  var KEY_FLASH = "tabungan_flash_v1";

  var NAMA_PENABUNG = { ojan: "Fauzan", nana: "Hafizha", emas: "Untung Emas" };
  var PETA_PENABUNG = {
    ojan: "ojan", fauzan: "ojan",
    nana: "nana", hafizha: "nana",
    emas: "emas", "untung emas": "emas"
  };
  var EXT_BUKTI = ["png", "jpg", "jpeg", "gif", "webp", "pdf"];
  var EXT_FOTO = ["png", "jpg", "jpeg", "gif", "webp"];
  var MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", pdf: "application/pdf"
  };
  var MAKS_MB_TANPA_KOMPRES = 10;   // untuk PDF/GIF (gambar lain dikecilkan otomatis)

  var currentPin = "";
  var refreshing = false;
  var sudahTampil = false;

  // ------------------------------------------------------------ util
  function $(sel) { return document.querySelector(sel); }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // "Rp1.000.000" (sama dengan filter rupiah di Flask)
  function rupiah(n) {
    var v = Number(n);
    if (!isFinite(v)) return "Rp0";
    return "Rp" + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function namaPenabung(kode) {
    return NAMA_PENABUNG[String(kode || "").toLowerCase()] || "—";
  }

  function hariIni() {   // tanggal lokal perangkat, format YYYY-MM-DD
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var t = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + t;
  }

  function ekstensi(nama) {
    var i = String(nama || "").lastIndexOf(".");
    return i < 0 ? "" : nama.slice(i + 1).toLowerCase();
  }

  function parseNominal(v) {
    var n = parseFloat(String(v || "0").replace(/[.,]/g, ""));
    return isFinite(n) ? n : 0;
  }

  function urutPemasukan(list) {   // tanggal terbaru dulu, lalu id terbesar
    return (list || []).slice().sort(function (a, b) {
      if (a.tanggal !== b.tanggal) return a.tanggal < b.tanggal ? 1 : -1;
      return Number(b.id) - Number(a.id);
    });
  }

  // ---------------------------------------------------- foto (Drive)
  function thumb(id, w) {
    return "https://drive.google.com/thumbnail?id=" + encodeURIComponent(id) + "&sz=w" + w;
  }
  function lh3(id) { return "https://lh3.googleusercontent.com/d/" + encodeURIComponent(id); }
  function viewUrl(id) { return "https://drive.google.com/file/d/" + encodeURIComponent(id) + "/view"; }

  // bila thumbnail gagal dimuat, coba alamat cadangan sekali
  document.addEventListener("error", function (e) {
    var el = e.target;
    if (el && el.tagName === "IMG" && el.dataset && el.dataset.fid && !el.dataset.fb) {
      el.dataset.fb = "1";
      el.src = lh3(el.dataset.fid);
    }
  }, true);

  function setImg(el, id, w) {
    if (!el) return;
    if (!id) { el.removeAttribute("src"); return; }
    if (el.dataset.fid === id) return;
    el.dataset.fid = id;
    delete el.dataset.fb;
    el.src = thumb(id, w);
  }

  function setBg(el, id, w) {
    if (!el) return;
    if (!id) { el.style.backgroundImage = ""; return; }
    if (el.dataset.fid === id) return;
    el.dataset.fid = id;
    var tried = false;
    var im = new Image();
    im.onload = function () { el.style.backgroundImage = 'url("' + im.src + '")'; };
    im.onerror = function () { if (!tried) { tried = true; im.src = lh3(id); } };
    im.src = thumb(id, w);
  }

  // ------------------------------------------------------- flash
  function flash(msg, cat) {
    var box = $("#flash");
    if (!box) return;
    box.insertAdjacentHTML("beforeend", '<div class="flash flash-' + cat + '">' + esc(msg) + "</div>");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clearFlash() { var b = $("#flash"); if (b) b.innerHTML = ""; }
  function queueFlash(msg, cat) {
    var q = [];
    try { q = JSON.parse(sessionStorage.getItem(KEY_FLASH) || "[]"); } catch (e) { q = []; }
    q.push([msg, cat]);
    sessionStorage.setItem(KEY_FLASH, JSON.stringify(q));
  }
  function showQueuedFlash() {
    var q = [];
    try { q = JSON.parse(sessionStorage.getItem(KEY_FLASH) || "[]"); } catch (e) { q = []; }
    sessionStorage.removeItem(KEY_FLASH);
    q.forEach(function (m) { flash(m[0], m[1]); });
  }

  // ---------------------------------------------------- PIN & cache
  function getPin() {
    return currentPin || sessionStorage.getItem(KEY_PIN) || localStorage.getItem(KEY_PIN) || "";
  }
  // PIN disimpan di SATU tempat saja:
  //   "ingat di perangkat ini" -> localStorage (semua tab; hilang saat tombol Kunci)
  //   tidak dicentang          -> sessionStorage (hanya tab ini; hilang saat tab ditutup)
  function simpanPin(pin, ingat) {
    currentPin = pin;
    if (ingat) { localStorage.setItem(KEY_PIN, pin); sessionStorage.removeItem(KEY_PIN); }
    else { sessionStorage.setItem(KEY_PIN, pin); localStorage.removeItem(KEY_PIN); }
  }
  function hapusSesi() {
    currentPin = "";
    sessionStorage.removeItem(KEY_PIN);
    localStorage.removeItem(KEY_PIN);
    sessionStorage.removeItem(KEY_CACHE);
  }
  function bacaCache() {
    try { return JSON.parse(sessionStorage.getItem(KEY_CACHE) || "null"); } catch (e) { return null; }
  }
  function tulisCache(d) {
    try { sessionStorage.setItem(KEY_CACHE, JSON.stringify(d)); } catch (e) { /* abaikan */ }
  }

  // ------------------------------------------------------------ API
  // Semua permintaan memakai POST "text/plain" supaya browser tidak
  // perlu preflight CORS (Apps Script tidak menjawab OPTIONS).
  function api(action, payload) {
    var body = JSON.stringify(Object.assign({ pin: getPin(), action: action }, payload || {}));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 90000);

    return fetch(CFG.WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: body,
      signal: ctrl.signal
    })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var data;
        try { data = JSON.parse(txt); }
        catch (e) {
          throw new Error("Balasan server tidak valid. Pastikan Web App di-deploy dengan akses “Anyone”.");
        }
        if (!data.ok) {
          var err = new Error(data.error || "Ditolak server");
          err.code = data.code;
          throw err;
        }
        return data;
      })
      .catch(function (e) {
        if (e && e.name === "AbortError") throw new Error("Server terlalu lama membalas, coba lagi.");
        if (e instanceof TypeError) throw new Error("Tidak bisa menghubungi server. Periksa koneksi internet.");
        throw e;
      })
      .then(
        function (v) { clearTimeout(timer); return v; },
        function (e) { clearTimeout(timer); throw e; }
      );
  }

  function configOk() {
    var u = String(CFG.WEBAPP_URL || "");
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(u);
  }

  // ------------------------------------------------- berkas -> base64
  function bacaBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { rej(new Error("File tidak bisa dibaca.")); };
      r.readAsDataURL(blob);
    });
  }

  function muatGambar(file) {
    function lewatImg() {
      return new Promise(function (res, rej) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); res(img); };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          rej(new Error("Gambar tidak bisa dibaca browser. Coba format JPG atau PNG."));
        };
        img.src = url;
      });
    }
    if (window.createImageBitmap) return createImageBitmap(file).catch(lewatImg);
    return lewatImg();
  }

  function kecilkanGambar(file, maksSisi, kualitas) {
    return muatGambar(file).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      var skala = Math.min(1, maksSisi / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * skala));
      var ch = Math.max(1, Math.round(h * skala));
      var canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(bmp, 0, 0, cw, ch);
      if (bmp.close) bmp.close();
      return new Promise(function (res, rej) {
        canvas.toBlob(function (b) {
          if (b) res(b); else rej(new Error("Gagal memampatkan gambar."));
        }, "image/jpeg", kualitas);
      });
    });
  }

  // hasil: { nama, mime, base64 }
  function siapkanFile(file, maksSisi, kualitas) {
    var ext = ekstensi(file.name);
    var dasar = file.name.replace(/\.[^.]+$/, "") || "file";
    if (ext === "pdf" || ext === "gif") {
      if (file.size > MAKS_MB_TANPA_KOMPRES * 1024 * 1024) {
        return Promise.reject(new Error("Ukuran file terlalu besar (maksimal " + MAKS_MB_TANPA_KOMPRES + " MB)."));
      }
      return bacaBase64(file).then(function (b64) {
        return { nama: file.name, mime: MIME[ext], base64: b64 };
      });
    }
    return kecilkanGambar(file, maksSisi, kualitas).then(function (blob) {
      return bacaBase64(blob).then(function (b64) {
        return { nama: dasar + ".jpg", mime: "image/jpeg", base64: b64 };
      });
    });
  }

  // -------------------------------------------------- layar PIN
  var gate;
  function bangunGate() {
    gate = document.createElement("div");
    gate.id = "gate";
    gate.className = "gate";
    gate.hidden = true;
    gate.innerHTML =
      '<div class="card gate-card">' +
      '<span class="brand-mark">💍</span>' +
      '<span class="script">Tabungan</span>' +
      "<h1>Fauzan &amp; Hafizha</h1>" +
      "<p>Masukkan PIN untuk membuka.</p>" +
      '<form id="gate-form" novalidate>' +
      '<div class="field"><label for="gate-pin">PIN</label>' +
      '<input id="gate-pin" type="password" autocomplete="current-password" required></div>' +
      '<label class="gate-check"><input type="checkbox" id="gate-ingat" checked> Ingat di perangkat ini</label>' +
      '<div class="gate-error" id="gate-error" role="alert"></div>' +
      '<button class="btn btn-primary" type="submit" id="gate-btn">Buka 🔓</button>' +
      "</form></div>";
    document.body.appendChild(gate);

    $("#gate-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var pin = $("#gate-pin").value.trim();
      var btn = $("#gate-btn");
      var err = $("#gate-error");
      if (!pin) { err.textContent = "PIN belum diisi."; return; }
      err.textContent = "";
      btn.disabled = true;
      btn.textContent = "Memeriksa…";
      currentPin = pin;
      api("data").then(function (d) {
        simpanPin(pin, $("#gate-ingat").checked);
        tulisCache(d);
        gate.hidden = true;
        $("#gate-pin").value = "";
        pageRender(d);
      }).catch(function (ex) {
        currentPin = "";
        err.textContent = ex.code === "PIN" ? "PIN salah. Coba lagi." : ex.message;
      }).then(function () {
        btn.disabled = false;
        btn.textContent = "Buka 🔓";
      });
    });
  }

  function tampilkanGate(pesan) {
    gate.hidden = false;
    $("#gate-error").textContent = pesan || "";
    setTimeout(function () { var i = $("#gate-pin"); if (i) i.focus(); }, 50);
  }

  // ------------------------------------------------ muat data
  var pageRender = function (d) { sudahTampil = true; pageRenderAsli(d); };
  var pageRenderAsli = function () {};

  function segarkan() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    return api("data").then(function (d) {
      tulisCache(d);
      pageRender(d);
    }).catch(galatMuat).then(function () { refreshing = false; });
  }

  function galatMuat(e) {
    if (e && e.code === "PIN") {
      hapusSesi();
      tampilkanGate("PIN tidak cocok lagi. Masukkan ulang.");
      return;
    }
    if (!sudahTampil) {
      document.querySelectorAll(".empty").forEach(function (el) { el.textContent = ""; });
    }
    var box = $("#flash");
    box.insertAdjacentHTML("beforeend",
      '<div class="flash flash-error">Gagal memuat data: ' + esc(e && e.message ? e.message : e) +
      ' <a href="#" data-retry>Coba lagi</a></div>');
  }

  // ------------------------------------------------ halaman: Beranda
  var Index = {
    init: function () {
      var form = $("#form-tambah");
      form.elements.tanggal.value = hariIni();

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        clearFlash();

        var tanggal = form.elements.tanggal.value || hariIni();
        var penabung = PETA_PENABUNG[String(form.elements.penabung.value).trim().toLowerCase()] || "";
        var nominal = parseNominal(form.elements.nominal.value);
        var sumber = form.elements.sumber.value.trim();
        var keterangan = form.elements.keterangan.value.trim();
        var file = form.elements.bukti.files[0];

        if (!penabung) { flash("Pilih dulu siapa yang menabung (Fauzan/Hafizha) 🙂", "error"); return; }
        if (nominal <= 0) { flash("Nominal harus lebih dari 0 ya 💸", "error"); return; }
        if (file && EXT_BUKTI.indexOf(ekstensi(file.name)) < 0) {
          flash("Format bukti tidak didukung (gunakan jpg/png/pdf).", "error");
          return;
        }

        var btn = $("#btn-tambah");
        btn.disabled = true;
        btn.textContent = "Menyimpan…";

        var siap = file ? siapkanFile(file, 2200, 0.85) : Promise.resolve(null);
        siap.then(function (bukti) {
          return api("tambah", {
            tanggal: tanggal, penabung: penabung, nominal: nominal,
            sumber: sumber, keterangan: keterangan, bukti: bukti
          });
        }).then(function (res) {
          flash("Pemasukan " + rupiah(nominal) + " dari " + NAMA_PENABUNG[penabung] + " berhasil dicatat! 🎉", "success");
          flash("Tersinkron ke Google Spreadsheet ✅", "success");
          if (res.message && res.message !== "tersimpan") flash("Catatan: " + res.message, "error");
          form.reset();
          form.elements.tanggal.value = hariIni();
          return segarkan();
        }).catch(function (ex) {
          if (ex.code === "PIN") { galatMuat(ex); return; }
          flash("Gagal menyimpan: " + ex.message, "error");
        }).then(function () {
          btn.disabled = false;
          btn.textContent = "Simpan Pemasukan 💾";
        });
      });
    },

    render: function (d) {
      var daftar = urutPemasukan(d.pemasukan);
      var total = daftar.reduce(function (s, p) { return s + (Number(p.nominal) || 0); }, 0);
      var target = Number(d.pengaturan && d.pengaturan.target) || 0;
      var catatan = (d.pengaturan && d.pengaturan.catatan) || "";
      var sisa = Math.max(target - total, 0);
      var persen = target > 0 ? Math.min(total / target * 100, 100) : 0;

      $("#progress-card").innerHTML =
        '<div class="progress-head"><div>' +
        '<span class="label">Terkumpul</span>' +
        '<h2 class="big-amount">' + rupiah(total) + "</h2>" +
        '<span class="muted">dari target ' + rupiah(target) + "</span>" +
        "</div>" +
        '<div class="progress-percent">' + persen.toFixed(1) + "%</div></div>" +
        '<div class="progress-bar"><div class="progress-fill" style="width: ' + persen + '%"></div></div>' +
        '<div class="stat-grid">' +
        '<div class="stat"><span class="stat-label">🎯 Target</span><span class="stat-value">' + rupiah(target) + "</span></div>" +
        '<div class="stat"><span class="stat-label">💰 Terkumpul</span><span class="stat-value">' + rupiah(total) + "</span></div>" +
        '<div class="stat"><span class="stat-label">⏳ Sisa</span><span class="stat-value">' + rupiah(sisa) + "</span></div>" +
        '<div class="stat"><span class="stat-label">📝 Transaksi</span><span class="stat-value">' + daftar.length + "x</span></div>" +
        "</div>" +
        (catatan ? '<div class="note-box">📌 ' + esc(catatan) + "</div>" : "");

      // foto pasangan
      var f = d.foto || {};
      setBg($("#hero-left"), f.foto2_duo, 1000);
      setBg($("#hero-right"), f.foto1_duo, 1000);
      setImg($("#couple-1"), f.foto2, 1000);
      setImg($("#couple-2"), f.foto1, 1000);
      $("#couple-1").parentNode.hidden = !f.foto2;
      $("#couple-2").parentNode.hidden = !f.foto1;
      $("#couple-strip").hidden = !(f.foto1 || f.foto2);

      // pemasukan terbaru (8)
      var terbaru = daftar.slice(0, 8);
      if (terbaru.length) {
        $("#latest").innerHTML =
          '<div class="table-wrap"><table class="table"><thead><tr>' +
          '<th>Tanggal</th><th>Penabung</th><th>Sumber</th><th>Keterangan</th><th class="right">Nominal</th><th>Bukti</th>' +
          "</tr></thead><tbody>" +
          terbaru.map(function (p) {
            return "<tr>" +
              "<td>" + esc(p.tanggal) + "</td>" +
              "<td>" + esc(namaPenabung(p.penabung)) + "</td>" +
              "<td>" + (esc(p.sumber) || "—") + "</td>" +
              "<td>" + (esc(p.keterangan) || "—") + "</td>" +
              '<td class="right amount-plus">+' + rupiah(p.nominal) + "</td>" +
              "<td>" + buktiLink(p) + "</td></tr>";
          }).join("") +
          "</tbody></table></div>";
      } else {
        $("#latest").innerHTML = '<p class="empty">Belum ada pemasukan. Yuk mulai menabung! 💖</p>';
      }

      // sneak peek momen (6 terbaru)
      var momen = (d.momen || []).slice(0, 6);
      $("#momen-card").hidden = momen.length === 0;
      $("#momen-preview").innerHTML = momen.map(function (m) {
        return '<figure class="momen-item">' +
          '<img data-fid="' + esc(m.foto_id) + '" src="' + esc(thumb(m.foto_id, 600)) + '" alt="' + esc(m.judul) + '" loading="lazy">' +
          (m.judul ? "<figcaption>" + esc(m.judul) + "</figcaption>" : "") +
          "</figure>";
      }).join("");
    }
  };

  function buktiLink(p) {
    return p.bukti_id
      ? '<a href="' + esc(viewUrl(p.bukti_id)) + '" target="_blank" rel="noopener" class="chip">Lihat</a>'
      : "—";
  }

  // ------------------------------------------------ halaman: Riwayat
  var Riwayat = {
    init: function () {
      $("#riwayat-list").addEventListener("click", function (e) {
        var a = e.target.closest("[data-hapus]");
        if (!a) return;
        e.preventDefault();
        if (!confirm("Hapus catatan ini?")) return;
        clearFlash();
        a.textContent = "Menghapus…";
        api("hapus", { id: Number(a.getAttribute("data-hapus")) }).then(function () {
          flash("Catatan pemasukan dihapus.", "success");
          return segarkan();
        }).catch(function (ex) {
          if (ex.code === "PIN") { galatMuat(ex); return; }
          flash("Gagal menghapus: " + ex.message, "error");
          a.textContent = "Hapus";
        });
      });
    },

    render: function (d) {
      var daftar = urutPemasukan(d.pemasukan);
      var total = daftar.reduce(function (s, p) { return s + (Number(p.nominal) || 0); }, 0);
      $("#total-badge").textContent = "Total: " + rupiah(total);

      if (!daftar.length) {
        $("#riwayat-list").innerHTML = '<p class="empty">Belum ada catatan pemasukan.</p>';
        return;
      }
      $("#riwayat-list").innerHTML =
        '<div class="table-wrap"><table class="table"><thead><tr>' +
        "<th>Tanggal</th><th>Penabung</th><th>Sumber</th><th>Keterangan</th>" +
        '<th class="right">Nominal</th><th>Bukti</th><th>Aksi</th>' +
        "</tr></thead><tbody>" +
        daftar.map(function (p) {
          return "<tr>" +
            "<td>" + esc(p.tanggal) + "</td>" +
            "<td>" + esc(namaPenabung(p.penabung)) + "</td>" +
            "<td>" + (esc(p.sumber) || "—") + "</td>" +
            "<td>" + (esc(p.keterangan) || "—") + "</td>" +
            '<td class="right amount-plus">+' + rupiah(p.nominal) + "</td>" +
            "<td>" + buktiLink(p) + "</td>" +
            '<td><a href="#" class="chip chip-danger" data-hapus="' + esc(p.id) + '">Hapus</a></td>' +
            "</tr>";
        }).join("") +
        "</tbody></table></div>";
    }
  };

  // ------------------------------------------------ halaman: Momen
  var Momen = {
    init: function () {
      var form = $("#form-momen");

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        clearFlash();
        var judul = form.elements.judul.value.trim();
        var caption = form.elements.caption.value.trim();
        var tanggal = form.elements.tanggal.value || hariIni();
        var file = form.elements.foto.files[0];

        if (!file) { flash("Silakan pilih foto untuk momen bahagia 📸", "error"); return; }
        if (EXT_FOTO.indexOf(ekstensi(file.name)) < 0) { flash("Format foto tidak didukung.", "error"); return; }

        var btn = $("#btn-momen");
        btn.disabled = true;
        btn.textContent = "Menyimpan…";

        siapkanFile(file, 1600, 0.85).then(function (foto) {
          return api("momen_tambah", { judul: judul, caption: caption, tanggal: tanggal, foto: foto });
        }).then(function () {
          flash("Momen bahagia berhasil ditambahkan! 💕", "success");
          form.reset();
          return segarkan();
        }).catch(function (ex) {
          if (ex.code === "PIN") { galatMuat(ex); return; }
          flash("Gagal menyimpan: " + ex.message, "error");
        }).then(function () {
          btn.disabled = false;
          btn.textContent = "Simpan Momen 💕";
        });
      });

      $("#galeri").addEventListener("click", function (e) {
        var a = e.target.closest("[data-hapus]");
        if (!a) return;
        e.preventDefault();
        if (!confirm("Hapus momen ini?")) return;
        clearFlash();
        a.textContent = "Menghapus…";
        api("momen_hapus", { id: Number(a.getAttribute("data-hapus")) }).then(function () {
          flash("Momen dihapus.", "success");
          return segarkan();
        }).catch(function (ex) {
          if (ex.code === "PIN") { galatMuat(ex); return; }
          flash("Gagal menghapus: " + ex.message, "error");
          a.textContent = "Hapus";
        });
      });
    },

    render: function (d) {
      var momen = d.momen || [];
      if (!momen.length) {
        $("#galeri").innerHTML = '<p class="empty">Belum ada momen. Abadikan kenangan indah kalian di sini! 🌸</p>';
        return;
      }
      $("#galeri").innerHTML = '<div class="momen-grid big">' + momen.map(function (m) {
        return '<figure class="momen-item card-momen">' +
          '<img data-fid="' + esc(m.foto_id) + '" src="' + esc(thumb(m.foto_id, 900)) + '" alt="' + esc(m.judul) + '" loading="lazy">' +
          "<figcaption>" +
          (m.judul ? "<strong>" + esc(m.judul) + "</strong>" : "") +
          (m.tanggal ? '<span class="momen-date">' + esc(m.tanggal) + "</span>" : "") +
          (m.caption ? "<p>" + esc(m.caption) + "</p>" : "") +
          '<a href="#" class="chip chip-danger" data-hapus="' + esc(m.id) + '">Hapus</a>' +
          "</figcaption></figure>";
      }).join("") + "</div>";
    }
  };

  // -------------------------------------------- halaman: Pengaturan
  var Pengaturan = {
    init: function () {
      var form = $("#form-pengaturan");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        clearFlash();
        var target = parseNominal(form.elements.target.value);
        var catatan = form.elements.catatan.value.trim();
        var btn = $("#btn-pengaturan");
        btn.disabled = true;
        btn.textContent = "Menyimpan…";
        api("pengaturan", { target: target, catatan: catatan }).then(function () {
          queueFlash("Target tabungan berhasil diperbarui! 🎯", "success");
          window.location.href = "index.html";
        }).catch(function (ex) {
          if (ex.code === "PIN") { galatMuat(ex); }
          else flash("Gagal menyimpan: " + ex.message, "error");
          btn.disabled = false;
          btn.textContent = "Simpan Pengaturan 💾";
        });
      });
    },

    render: function (d) {
      var form = $("#form-pengaturan");
      var p = d.pengaturan || {};
      // isi hanya sekali supaya ketikan Anda tidak tertimpa saat data disegarkan
      if (!form.dataset.terisi) {
        form.elements.target.value = Math.round(Number(p.target) || 0);
        form.elements.catatan.value = p.catatan || "";
        form.dataset.terisi = "1";
      }
      form.elements.target.disabled = false;
      form.elements.catatan.disabled = false;
      $("#btn-pengaturan").disabled = false;
    }
  };

  // ------------------------------------------------------------ mulai
  function mulai() {
    var halaman = { index: Index, riwayat: Riwayat, momen: Momen, pengaturan: Pengaturan }[document.body.getAttribute("data-page")];
    if (!halaman) return;

    bangunGate();
    halaman.init();
    pageRenderAsli = halaman.render;
    showQueuedFlash();

    $("#lock-link").addEventListener("click", function (e) {
      e.preventDefault();
      hapusSesi();
      window.location.reload();
    });

    document.addEventListener("click", function (e) {
      var r = e.target.closest("[data-retry]");
      if (!r) return;
      e.preventDefault();
      clearFlash();
      segarkan();
    });

    if (!configOk()) {
      document.querySelectorAll(".empty").forEach(function (el) { el.textContent = ""; });
      flash("Alamat server belum diisi. Buka file config.js lalu tempel URL Web App (lihat PANDUAN.md, Langkah 4).", "error");
      return;
    }

    if (getPin()) {
      var cache = bacaCache();
      if (cache) pageRender(cache);          // tampil instan, lalu disegarkan
      segarkan();
    } else {
      tampilkanGate();
    }
  }

  mulai();
})();
