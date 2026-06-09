(function () {
  const adminDashboardVersion = "20260602-recap-gap";
  window.AdminDashboardVersion = adminDashboardVersion;
  console.info(`Admin dashboard script loaded: ${adminDashboardVersion}`);

  const authKey = "recruitment.admin.authenticated";
  const adminRegionKey = "recruitment.admin.region";
  const adminNameKey = "recruitment.admin.name";
  const adminUsernameKey = "recruitment.admin.username";

  if (window.sessionStorage.getItem(authKey) !== "1" || !window.sessionStorage.getItem(adminRegionKey) || !window.sessionStorage.getItem(adminUsernameKey)) {
    window.location.replace("admin_login.html");
    return;
  }

  // Elemen-elemen ini adalah titik masuk dashboard; isi tabel dan modal dibuat lewat JavaScript.
  const app = document.querySelector("#dashboardApp");
  const flash = document.querySelector("#flash");
  const modalLayer = document.querySelector("#modalLayer");
  const modalContent = document.querySelector("#modalContent");
  const pageTitle = document.querySelector("#pageTitle");
  const profileMenu = document.querySelector("#profileMenu");
  const profileMenuToggle = document.querySelector('[data-action="toggle-profile-menu"]');
  const confirmLayer = document.querySelector("#confirmLayer");
  const confirmDialog = confirmLayer.querySelector(".confirm-dialog");
  const confirmIcon = document.querySelector("#confirmIcon");
  const confirmTitle = document.querySelector("#confirmTitle");
  const confirmMessage = document.querySelector("#confirmMessage");
  const confirmSubmit = confirmLayer.querySelector(".confirm-submit");
  const adminRegion = window.sessionStorage.getItem(adminRegionKey);
  const adminName = window.sessionStorage.getItem(adminNameKey) || `Admin ${adminRegion}`;
  const adminUsername = window.sessionStorage.getItem(adminUsernameKey) || "";
  const adminInitials = adminName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  let tokenTimerInterval = null;

  document.querySelectorAll(".profile-name").forEach((element) => {
    element.textContent = adminName;
  });
  document.querySelectorAll(".admin-pill").forEach((element) => {
    // Debug: region pill berasal dari session login, sehingga sdm_jakarta tetap masuk scope Jakarta.
    element.textContent = "Admin";
  });
  document.querySelectorAll(".avatar").forEach((element) => {
    element.textContent = adminInitials || "AD";
  });

  // State selalu diisi ulang dari MySQL lewat admin_api.php setiap render.
  let state = {
    educationLevels: [],
    courses: [],
    questionBanks: [],
    applications: [],
    activeToken: null
  };

  // Filter lokal untuk tabel Test Result. Draft baru diterapkan ke tabel setelah tombol Apply ditekan.
  let courseFilters = {
    position: "",
    status: ""
  };
  let courseFilterDrafts = { ...courseFilters };
  let positionFilters = {
    name: ""
  };
  let positionFilterDrafts = { ...positionFilters };
  let courseSort = {
    key: "",
    direction: "asc"
  };
  let positionSort = {
    key: "",
    direction: "asc"
  };
  let resultFilters = {
    course: "",
    education: ""
  };
  let resultFilterDrafts = { ...resultFilters };
  let resultSort = {
    key: "date",
    direction: "desc"
  };
  let resultViewMode = "results";
  let resultServerTotal = 0;
  let resultServerFilterOptions = {
    course: [],
    education: []
  };
  let recapitulations = [];
  let recapServerTotal = 0;
  let activeRecapitulation = null;

  // Pagination tiap tabel disimpan terpisah agar Course, Question Bank, dan Results punya posisi sendiri.
  const pageSizeOptions = [5, 10, 15, 20, 50];
  const tablePagination = {
    course: { page: 1, pageSize: 5 },
    position: { page: 1, pageSize: 5 },
    questions: { page: 1, pageSize: 5 },
    results: { page: 1, pageSize: 5 }
  };

  // State sementara untuk halaman Fill Question Bank. Isinya berubah saat user klik pagination soal.
  let questionBankDraft = null;
  let essayReviewDraft = null;
  const questionTemplatePath = "Image/template_bulk_upload_soal.xlsx";
  const questionTemplateColumns = ["questionType", "questionText", "optionA", "optionB", "optionC", "optionD", "correctOption"];

  const sectionTitles = {
    course: "Course List",
    questions: "Question Bank",
    results: "Test Results",
    token: "Exam Token"
  };

  // Section aktif dibaca dari query string, contoh: admin_dashboard.html?section=results.
  function activeSection() {
    const section = new URLSearchParams(window.location.search).get("section") || "course";
    return sectionTitles[section] ? section : "course";
  }

  // Action dipakai untuk mode halaman khusus, misalnya halaman Create Course.
  function activeAction() {
    return new URLSearchParams(window.location.search).get("action") || "";
  }

  // ID aktif dibaca dari query string untuk halaman View/Edit Course.
  function activeId() {
    return Number(new URLSearchParams(window.location.search).get("id") || 0);
  }

  function activeCourseMode(section = activeSection(), action = activeAction()) {
    return section === "course" && ["positions", "position-create", "position-view"].includes(action) ? "position" : "course";
  }

  function activeRecapId() {
    return new URLSearchParams(window.location.search).get("recapId") || "";
  }

  // Mengganti tab dashboard tanpa reload penuh, lalu render ulang data terbaru.
  async function navigate(section, action = "", id = 0) {
    const actionQuery = action ? `&action=${encodeURIComponent(action)}` : "";
    const idQuery = id ? `&id=${encodeURIComponent(id)}` : "";
    window.history.pushState({}, "", `admin_dashboard.html?section=${section}${actionQuery}${idQuery}`);
    await render();
  }

  async function navigateRecapitulation(recapId) {
    // Recap ID bukan angka, jadi disimpan di query recapId terpisah dari id result biasa.
    window.history.pushState({}, "", `admin_dashboard.html?section=results&action=recap-view&recapId=${encodeURIComponent(recapId)}`);
    await render();
  }

  // Mencegah teks dari database menjadi HTML aktif saat dirender ke tabel/modal.
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function richTextHtml(value) {
    // Rich text disimpan sebagai tag HTML sederhana dari toolbar editor.
    // Tetap escape seluruh teks dulu, lalu buka hanya tag formatting yang kita izinkan.
    return escapeHtml(String(value || "").replace(/&(amp;)?nbsp;/gi, " "))
      .replace(/&lt;(\/?)(strong|em|u|s|ul|li|br)&gt;/g, "<$1$2>")
      .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
      .replace(/\b([A-Za-z0-9]+)\^([A-Za-z0-9+-]+)\b/g, "$1<sup>$2</sup>")
      .replace(/\n/g, "<br>");
  }

  function hasArabicText(value) {
    return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u.test(String(value || ""));
  }

  function rtlAttrs(value) {
    return hasArabicText(value) ? ' dir="auto" class="rtl-text"' : "";
  }

  function answerLabelHtml(answer, value) {
    return hasArabicText(value)
      ? `<span class="option-letter" aria-hidden="true">${escapeHtml(answer)}.</span><span${rtlAttrs(value)}>${escapeHtml(value)}</span>`
      : `<span>${escapeHtml(`${answer}. ${value || ""}`)}</span>`;
  }

  function questionTitleHtml(number, questionText, badgeHtml = "") {
    return `
      <h2 class="question-title">
        <span class="question-number">${escapeHtml(number)}.</span>
        <span${rtlAttrs(questionText)}>${richTextHtml(questionText)}${badgeHtml}</span>
      </h2>
    `;
  }

  const equationSymbols = [
    ["x²", "x²"],
    ["x^n", "x^n"],
    ["√x", "√x"],
    ["a/b", "a/b"],
    ["lim", "lim"],
    ["∫", "∫"],
    ["d/dx", "d/dx"],
    ["Σ", "Σ"],
    ["π", "π"],
    ["∞", "∞"],
    ["≤", "≤"],
    ["≥", "≥"],
    ["≠", "≠"],
    ["±", "±"],
    ["θ", "θ"],
    ["→", "→"]
  ];

  function equationToolbarHtml() {
    return `
      <div class="equation-toolbar" aria-label="Math equation toolbar">
        <strong>MATH</strong>
        ${equationSymbols.map(([label, value]) => `
          <button class="equation-tool" type="button" data-action="insert-equation-symbol" data-symbol="${escapeHtml(value)}" aria-label="Insert ${escapeHtml(label)}">${escapeHtml(label)}</button>
        `).join("")}
      </div>
    `;
  }

  function editorToolbarHtml() {
    return `
      <div class="editor-toolbar" aria-label="Text formatting toolbar">
        <button class="editor-tool" type="button" data-action="format-editor-text" data-format="bold" aria-label="Bold"><strong>B</strong></button>
        <button class="editor-tool" type="button" data-action="format-editor-text" data-format="italic" aria-label="Italic"><i>/</i></button>
        <button class="editor-tool" type="button" data-action="format-editor-text" data-format="underline" aria-label="Underline"><u>U</u></button>
        <button class="editor-tool" type="button" data-action="format-editor-text" data-format="strike" aria-label="Strikethrough"><s>S</s></button>
        <button class="editor-tool" type="button" data-action="format-editor-text" data-format="list" aria-label="Bullet list"><i data-lucide="list"></i></button>
        <span class="resize-icon" aria-hidden="true"><i data-lucide="move-diagonal-2"></i></span>
      </div>
    `;
  }

  function editorFieldHtml(name, value, placeholder) {
    return `
      <textarea class="editor-value" name="${escapeHtml(name)}">${escapeHtml(value || "")}</textarea>
      <div class="editor-textarea" contenteditable="true" data-editor-input data-placeholder="${escapeHtml(placeholder)}"${rtlAttrs(value)}>${richTextHtml(value || "")}</div>
      ${name === "questionText" ? equationToolbarHtml() : ""}
    `;
  }

  function sanitizeEditorHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html || "")
      .replace(/<div[^>]*>/gi, "<br>")
      .replace(/<\/div>/gi, "")
      .replace(/<p[^>]*>/gi, "<br>")
      .replace(/<\/p>/gi, "");
    const allowedTags = new Set(["STRONG", "EM", "U", "S", "UL", "LI", "BR"]);
    const aliases = {
      B: "STRONG",
      I: "EM",
      STRIKE: "S",
      DEL: "S"
    };

    function cleanNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return document.createTextNode(node.textContent || "");
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return document.createTextNode("");
      }

      const tagName = aliases[node.tagName] || node.tagName;
      if (!allowedTags.has(tagName)) {
        const fragment = document.createDocumentFragment();
        node.childNodes.forEach((child) => fragment.appendChild(cleanNode(child)));
        return fragment;
      }

      const element = document.createElement(tagName.toLowerCase());
      node.childNodes.forEach((child) => element.appendChild(cleanNode(child)));
      return element;
    }

    const fragment = document.createDocumentFragment();
    template.content.childNodes.forEach((node) => fragment.appendChild(cleanNode(node)));
    const wrapper = document.createElement("div");
    wrapper.appendChild(fragment);
    return wrapper.innerHTML
      .replace(/^(<br\s*\/?>)+/gi, "")
      .replace(/(<br\s*\/?>)+$/gi, "")
      .replace(/&(amp;)?nbsp;/gi, " ");
  }

  function insertEditorLineBreak(editor) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return;
    }

    range.deleteContents();
    const lineBreak = document.createElement("br");
    range.insertNode(lineBreak);
    range.setStartAfter(lineBreak);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    syncEditorValue(editor);
  }

  function syncEditorValue(editor) {
    const shell = editor.closest(".editor-shell");
    const value = shell?.querySelector(".editor-value");
    if (value) {
      value.value = sanitizeEditorHtml(editor.innerHTML);
    }
    editor.dir = hasArabicText(editor.textContent) ? "auto" : "ltr";
    editor.classList.toggle("rtl-text", editor.dir === "auto");
  }

  function syncAllEditors(root = document) {
    root.querySelectorAll("[data-editor-input]").forEach(syncEditorValue);
  }

  function applyEditorFormat(trigger) {
    const editor = trigger.closest(".editor-shell");
    const input = editor?.querySelector("[data-editor-input]");
    if (!input) {
      return;
    }

    const format = trigger.dataset.format;
    input.focus();

    const commands = {
      bold: "bold",
      italic: "italic",
      underline: "underline",
      strike: "strikeThrough",
      list: "insertUnorderedList"
    };

    if (commands[format]) {
      document.execCommand(commands[format], false);
      syncEditorValue(input);
    }
  }

  function insertEquationSymbol(trigger) {
    const editor = trigger.closest(".editor-shell");
    const input = editor?.querySelector("[data-editor-input]");
    const symbol = trigger.dataset.symbol || "";
    if (!input || !symbol) {
      return;
    }

    // Debug: simbol equation disisipkan ke contenteditable aktif lalu langsung disinkronkan ke textarea tersembunyi.
    input.focus();
    document.execCommand("insertText", false, symbol);
    syncEditorValue(input);
  }

  function isQuestionImageDataUrl(value) {
    return /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(String(value || ""));
  }

  function questionImageHtml(question) {
    if (!isQuestionImageDataUrl(question.imageData)) {
      return "";
    }

    return `
      <figure class="question-image-preview">
        <img src="${escapeHtml(question.imageData)}" alt="${escapeHtml(question.imageName || "Question image")}">
      </figure>
    `;
  }

  // Memendekkan pertanyaan panjang supaya tabel tetap mudah dibaca.
  function excerpt(value, limit = 86) {
    const text = String(value || "");
    return text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
  }

  // Format tanggal dari MySQL untuk kolom Submitted.
  function dateLabel(value) {
    if (!value) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value.replace(" ", "T")));
  }

  // Pesan kecil di atas dashboard setelah save/delete/reset.
  function showFlash(message, type = "success") {
    flash.textContent = message;
    flash.className = `flash is-open${type === "danger" ? " is-danger" : ""}`;
    window.setTimeout(() => {
      flash.className = "flash";
    }, 3200);
  }

  // Popup kecil setelah Publish berhasil. Elemen dibuat sementara agar tidak perlu markup HTML statis.
  function showSuccessPopup(message) {
    const popup = document.createElement("div");
    popup.className = "success-popup";
    popup.innerHTML = `
      <div class="success-popup-icon"><i data-lucide="check"></i></div>
      <strong>${escapeHtml(message)}</strong>
    `;
    document.body.appendChild(popup);

    if (window.lucide) {
      window.lucide.createIcons();
    }

    window.setTimeout(() => popup.classList.add("is-visible"), 20);
    window.setTimeout(() => {
      popup.classList.remove("is-visible");
      window.setTimeout(() => popup.remove(), 220);
    }, 2600);
  }

  // Popup validasi untuk Create/Edit Question Bank agar error field tampil di tengah layar.
  function showValidationPopup(message) {
    const existingPopup = document.querySelector(".validation-popup-layer");
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement("div");
    popup.className = "validation-popup-layer";
    popup.innerHTML = `
      <div class="validation-popup" role="dialog" aria-modal="true" aria-labelledby="validationPopupTitle">
        <button class="validation-popup-close" type="button" data-validation-popup-close aria-label="Close validation popup">
          <i data-lucide="x"></i>
        </button>
        <div class="validation-popup-icon"><i data-lucide="triangle-alert"></i></div>
        <h2 id="validationPopupTitle">Validation Required</h2>
        <p>${escapeHtml(message)}</p>
      </div>
    `;

    document.body.appendChild(popup);

    if (window.lucide) {
      window.lucide.createIcons();
    }

    const close = () => popup.remove();
    popup.addEventListener("click", (event) => {
      if (event.target === popup || event.target.closest("[data-validation-popup-close]")) {
        close();
      }
    });
  }

  // Debug UX: popup ini dipakai setelah review essay final agar admin diarahkan jelas ke tabel hasil.
  function showReviewCompletePopup() {
    const existingPopup = document.querySelector(".validation-popup-layer");
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement("div");
    popup.className = "validation-popup-layer";
    popup.innerHTML = `
      <div class="validation-popup review-complete-popup" role="dialog" aria-modal="true" aria-labelledby="reviewCompleteTitle">
        <button class="validation-popup-close" type="button" data-review-complete-close aria-label="Close review complete popup">
          <i data-lucide="x"></i>
        </button>
        <div class="validation-popup-icon"><i data-lucide="check"></i></div>
        <h2 id="reviewCompleteTitle">Essay Review Completed</h2>
        <p>Essay review has been finalized and saved to the database.</p>
        <div class="confirm-actions">
          <button class="confirm-submit" type="button" data-review-complete-results>Go to Test Result</button>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    if (window.lucide) {
      window.lucide.createIcons();
    }

    popup.addEventListener("click", async (event) => {
      if (event.target === popup || event.target.closest("[data-review-complete-close]")) {
        popup.remove();
        return;
      }

      if (event.target.closest("[data-review-complete-results]")) {
        popup.remove();
        await navigate("results");
      }
    });
  }

  function showScoreWeightPopup(result) {
    const hasMc = questionsForResult(result).some((question) => question.questionType !== "essay");
    const hasEssay = resultHasEssay(result);
    const defaultMcWeight = hasMc && hasEssay ? 50 : hasMc ? 100 : 0;
    const defaultEssayWeight = hasMc && hasEssay ? 50 : hasEssay ? 100 : 0;
    const defaultEssayScore = hasEssay ? essayScore(result) : 0;
    const popup = document.createElement("div");
    popup.className = "validation-popup-layer";
    popup.innerHTML = `
      <div class="validation-popup score-weight-popup" role="dialog" aria-modal="true">
        <button class="validation-popup-close" type="button" data-score-close aria-label="Close score popup">
          <i data-lucide="x"></i>
        </button>
        <h2>Give Score</h2>
        <p>Multiple Choice: ${escapeHtml(multipleChoiceScore(result))} | Essay: ${escapeHtml(essayScore(result))}</p>
        <label>
          <span>Essay Final Score</span>
          <input class="create-input" name="essayScore" type="number" min="0" max="100" step="1" value="${defaultEssayScore}"${hasEssay ? "" : " disabled"}>
        </label>
        <label>
          <span>Multiple Choice Weight (%)</span>
          <input class="create-input" name="multipleChoiceWeight" type="number" min="0" max="100" step="1" value="${defaultMcWeight}"${hasMc && hasEssay ? "" : " disabled"}>
        </label>
        <label>
          <span>Essay Weight (%)</span>
          <input class="create-input" name="essayWeight" type="number" min="0" max="100" step="1" value="${defaultEssayWeight}"${hasMc && hasEssay ? "" : " disabled"}>
        </label>
        <div class="confirm-actions">
          <button class="confirm-cancel" type="button" data-score-close>Cancel</button>
          <button class="confirm-submit" type="button" data-score-submit>Save Score</button>
        </div>
      </div>
    `;
    document.body.appendChild(popup);

    if (window.lucide) {
      window.lucide.createIcons();
    }

    const syncWeights = (changedInput) => {
      const mcInput = popup.querySelector('[name="multipleChoiceWeight"]');
      const essayInput = popup.querySelector('[name="essayWeight"]');
      const clamp = (value) => Math.round(Math.max(0, Math.min(100, Number(value) || 0)));

      // Debug: bobot MC + Essay selalu dibuat 100% di UI agar tidak bisa lebih/kurang.
      if (changedInput === mcInput && !essayInput.disabled) {
        mcInput.value = clamp(mcInput.value);
        essayInput.value = 100 - Number(mcInput.value);
      } else if (changedInput === essayInput && !mcInput.disabled) {
        essayInput.value = clamp(essayInput.value);
        mcInput.value = 100 - Number(essayInput.value);
      }
    };

    popup.addEventListener("input", (event) => {
      if (event.target.matches('[name="multipleChoiceWeight"], [name="essayWeight"]')) {
        syncWeights(event.target);
      }
    });

    return new Promise((resolve) => {
      popup.addEventListener("click", (event) => {
        if (event.target === popup || event.target.closest("[data-score-close]")) {
          popup.remove();
          resolve(null);
          return;
        }

        if (event.target.closest("[data-score-submit]")) {
          const multipleChoiceWeight = Number(popup.querySelector('[name="multipleChoiceWeight"]').value || 0);
          const essayWeight = Number(popup.querySelector('[name="essayWeight"]').value || 0);
          const manualEssayScore = Number(popup.querySelector('[name="essayScore"]').value || 0);
          popup.remove();
          resolve({ multipleChoiceWeight, essayWeight, essayScore: manualEssayScore });
        }
      });
    });
  }

  function showImportGuidePopup() {
    const popup = document.createElement("div");
    popup.className = "validation-popup-layer";
    popup.innerHTML = `
      <div class="validation-popup import-guide-popup" role="dialog" aria-modal="true" aria-labelledby="importGuideTitle">
        <button class="validation-popup-close" type="button" data-import-guide-close aria-label="Close import guide">
          <i data-lucide="x"></i>
        </button>
        <div class="validation-popup-icon"><i data-lucide="info"></i></div>
        <h2 id="importGuideTitle">Template Guide</h2>
        <ol>
          <li>Sesuaikan tipe soal apakah multiple choice atau essay menggunakan dropdown menu yang muncul di kolom questionType.</li>
          <li>Isi soal di kolom questionText.</li>
          <li>Jika multiple choice isi option A-D dan correctOption.</li>
          <li>Jika Essay abaikan option A-D dan correctOption.</li>
          <li>Untuk saat ini abaikan imageData dan imageName.</li>
        </ol>
      </div>
    `;
    document.body.appendChild(popup);

    if (window.lucide) {
      window.lucide.createIcons();
    }

    popup.addEventListener("click", (event) => {
      if (event.target === popup || event.target.closest("[data-import-guide-close]")) {
        popup.remove();
      }
    });
  }

  function normalizeTemplateCell(value) {
    return String(value ?? "").trim();
  }

  function normalizeQuestionType(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_") === "essay" ? "essay" : "multiple_choice";
  }

  function createImportPreviewRow(row, index) {
    const questionType = normalizeQuestionType(row.questionType);
    const question = {
      questionType,
      questionText: normalizeTemplateCell(row.questionText),
      optionA: normalizeTemplateCell(row.optionA),
      optionB: normalizeTemplateCell(row.optionB),
      optionC: normalizeTemplateCell(row.optionC),
      optionD: normalizeTemplateCell(row.optionD),
      correctOption: normalizeTemplateCell(row.correctOption).toUpperCase(),
      imageData: "",
      imageName: ""
    };
    const errors = [];

    if (!question.questionText) errors.push("questionText wajib diisi");
    if (question.questionType === "multiple_choice") {
      if (!question.optionA) errors.push("optionA wajib diisi");
      if (!question.optionB) errors.push("optionB wajib diisi");
      if (!question.optionC) errors.push("optionC wajib diisi");
      if (!question.optionD) errors.push("optionD wajib diisi");
      if (!["A", "B", "C", "D"].includes(question.correctOption)) errors.push("correctOption harus A/B/C/D");
    }

    return {
      index: index + 1,
      question,
      errors
    };
  }

  function parseQuestionTemplateRows(workbook) {
    const sheet = workbook.Sheets.Isi_Soal || workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      throw new Error("Sheet Isi_Soal tidak ditemukan.");
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    const headers = new Set(Object.keys(rows[0] || {}));
    const missingColumns = questionTemplateColumns.filter((column) => !headers.has(column));
    if (missingColumns.length) {
      throw new Error(`Template tidak sesuai. Kolom hilang: ${missingColumns.join(", ")}.`);
    }

    return rows
      .filter((row) => questionTemplateColumns.some((column) => normalizeTemplateCell(row[column]) !== ""))
      .map(createImportPreviewRow);
  }

  function hasQuestionContent(question) {
    return ["questionText", "optionA", "optionB", "optionC", "optionD", "correctOption", "imageData"]
      .some((key) => normalizeTemplateCell(question[key]) !== "");
  }

  // Popup confirmation reusable. Mengembalikan Promise<boolean> supaya bisa dipakai seperti window.confirm.
  function showConfirmDialog(options) {
    const config = {
      title: "Ready to submit?",
      message: "Don't worry, you can edit your submission anytime",
      confirmText: "Confirm",
      icon: "circle-help",
      tone: "primary",
      ...options
    };

    confirmDialog.className = `confirm-dialog is-${config.tone}`;
    confirmTitle.textContent = config.title;
    confirmMessage.textContent = config.message;
    confirmSubmit.textContent = config.confirmText;
    confirmIcon.innerHTML = `<i data-lucide="${config.icon}"></i>`;
    confirmLayer.classList.add("is-open");
    confirmLayer.setAttribute("aria-hidden", "false");

    if (window.lucide) {
      window.lucide.createIcons();
    }

    return new Promise((resolve) => {
      const finish = (value) => {
        confirmLayer.classList.remove("is-open");
        confirmLayer.setAttribute("aria-hidden", "true");
        confirmLayer.removeEventListener("click", onLayerClick);
        document.removeEventListener("keydown", onEscape);
        resolve(value);
      };

      const onLayerClick = (event) => {
        const confirmAction = event.target.closest("[data-confirm]");
        if (confirmAction) {
          finish(confirmAction.dataset.confirm === "ok");
          return;
        }

        if (event.target === confirmLayer) {
          finish(false);
        }
      };

      const onEscape = (event) => {
        if (event.key === "Escape") {
          finish(false);
        }
      };

      confirmLayer.addEventListener("click", onLayerClick);
      document.addEventListener("keydown", onEscape);
      confirmSubmit.focus();
    });
  }

  // Konfigurasi popup untuk setiap jenis aksi penting di dashboard.
  function confirmOptions(type) {
    const options = {
      submit: {
        title: "Ready to submit?",
        message: "Don't worry, you can edit your submission anytime",
        confirmText: "Confirm",
        icon: "circle-help",
        tone: "primary"
      },
      edit: {
        title: "Save Changes?",
        message: "Updating will save your latest changes and apply them",
        confirmText: "Confirm",
        icon: "circle-help",
        tone: "primary"
      },
      delete: {
        title: "Delete this item?",
        message: "This item will be permanently deleted",
        confirmText: "Delete",
        icon: "trash-2",
        tone: "danger"
      },
      active: {
        title: "Set as active?",
        message: "This item will be activated and available for use",
        confirmText: "Confirm",
        icon: "check",
        tone: "success"
      },
      inactive: {
        title: "Set as Inactive?",
        message: "Setting this as inactive will hide or disable it from use",
        confirmText: "Confirm",
        icon: "x",
        tone: "danger"
      }
    };

    return options[type] || options.submit;
  }

  // HTML badge status reused di tabel course dan question.
  function statusPill(isPublished) {
    return `<span class="status-pill${Number(isPublished) === 1 ? "" : " is-draft"}">${Number(isPublished) === 1 ? "Published" : "Inactive"}</span>`;
  }

  // Badge khusus Question Bank agar label status sesuai kebutuhan publish/unpublish.
  function questionBankStatusPill(isPublished) {
    return `<span class="status-pill${Number(isPublished) === 1 ? "" : " is-draft"}">${Number(isPublished) === 1 ? "Published" : "Inactive"}</span>`;
  }

  async function loadQuestionBankDetail(questionBankId) {
    // Detail questions_json hanya dimuat saat View/Edit agar list Question Bank tidak berat.
    const detail = await window.RecruitmentStore.getQuestionBank(questionBankId);
    if (!detail) {
      return;
    }

    const index = state.questionBanks.findIndex((bank) => Number(bank.id) === Number(detail.id));
    if (index >= 0) {
      state.questionBanks[index] = { ...state.questionBanks[index], ...detail };
    } else {
      state.questionBanks.push(detail);
    }
  }

  async function loadResultDetail(resultId) {
    // Detail resultQuestions/answers baru diambil saat View/Review/Give Score/PDF.
    const detail = await window.RecruitmentStore.getResult(resultId);
    if (!detail) {
      return;
    }

    const index = state.applications.findIndex((application) => Number(application.id) === Number(detail.id));
    if (index >= 0) {
      state.applications[index] = { ...state.applications[index], ...detail };
    } else {
      state.applications.push(detail);
    }
  }

  async function loadRecapitulationDetail(recapId) {
    // Halaman View recap mengambil semua test result peserta dalam satu request khusus.
    activeRecapitulation = await window.RecruitmentStore.getRecapitulation(recapId);
    if (activeRecapitulation?.results?.length) {
      activeRecapitulation.results.forEach((detail) => {
        const index = state.applications.findIndex((application) => Number(application.id) === Number(detail.id));
        if (index >= 0) {
          state.applications[index] = { ...state.applications[index], ...detail };
        } else {
          state.applications.push(detail);
        }
      });
    }
  }

  async function loadStateForRoute(section = activeSection(), action = activeAction(), recordId = activeId()) {
    // Setiap menu memuat data sekecil mungkin supaya pindah tab production tidak menarik payload besar.
    if (section === "course") {
      const [courses, educationLevels] = await Promise.all([
        window.RecruitmentStore.getCourses(),
        window.RecruitmentStore.getEducationLevels()
      ]);
      state.courses = courses;
      state.educationLevels = educationLevels;
      return;
    }

    if (section === "questions") {
      const [courses, questionBanks] = await Promise.all([
        window.RecruitmentStore.getCourses(),
        window.RecruitmentStore.getQuestionBanks()
      ]);
      state.courses = courses;
      state.questionBanks = questionBanks;
      if ((action === "view" || action === "edit") && recordId) {
        await loadQuestionBankDetail(recordId);
      }
      return;
    }

    if (section === "results") {
      activeRecapitulation = null;
      if (action === "recap-view") {
        // Saat detail recap dibuka langsung/refresh, mode tabel tetap dikunci ke Recapitulation.
        resultViewMode = "recap";
      }
      const resultPage = tablePagination.results;
      const listRequest = resultViewMode === "recap"
        ? window.RecruitmentStore.getRecapitulations({
          page: resultPage.page,
          pageSize: resultPage.pageSize,
          course: resultFilters.course,
          education: resultFilters.education,
          sortKey: resultSort.key,
          sortDirection: resultSort.direction
        })
        : window.RecruitmentStore.getResults({
          page: resultPage.page,
          pageSize: resultPage.pageSize,
          course: resultFilters.course,
          education: resultFilters.education,
          sortKey: resultSort.key,
          sortDirection: resultSort.direction
        });
      const [questionBanks, listPayload] = await Promise.all([
        window.RecruitmentStore.getQuestionBanks(),
        listRequest
      ]);
      state.questionBanks = questionBanks;
      if (resultViewMode === "recap") {
        recapitulations = listPayload.recapitulations;
        recapServerTotal = listPayload.total;
      } else {
        state.applications = listPayload.applications;
        resultServerTotal = listPayload.total;
      }
      resultServerFilterOptions = listPayload.filterOptions || { course: [], education: [] };
      tablePagination.results.page = listPayload.page || resultPage.page;
      tablePagination.results.pageSize = listPayload.pageSize || resultPage.pageSize;
      if (action === "recap-view" && activeRecapId()) {
        await loadRecapitulationDetail(activeRecapId());
      }
      if ((action === "view" || action === "review") && recordId) {
        await loadResultDetail(recordId);
      }
      return;
    }

    if (section === "token") {
      state.activeToken = await window.RecruitmentStore.getActiveToken();
      return;
    }

    state = await window.RecruitmentStore.getState();
  }

  function positionNames() {
    const rows = Array.isArray(state.educationLevels) ? state.educationLevels : [];
    return rows.map((position) => position.name || position).filter(Boolean);
  }

  function findPosition(positionId) {
    return (state.educationLevels || []).find((position) => Number(position.id) === Number(positionId));
  }

  function courseEducationLevels(course) {
    if (Array.isArray(course.educationLevels) && course.educationLevels.length) {
      return course.educationLevels;
    }

    const decoded = (() => {
      try {
        return JSON.parse(course.educationLevel || "[]");
      } catch (error) {
        return null;
      }
    })();

    return Array.isArray(decoded) && decoded.length ? decoded : [course.educationLevel || ""].filter(Boolean);
  }

  function courseEducationLabel(course) {
    return courseEducationLevels(course).join(", ");
  }

  // Menggabungkan course dengan jumlah question-nya untuk kolom Questions.
  function coursesWithTotals() {
    return state.courses.map((course) => ({
      ...course,
      totalQuestions: Number.isFinite(Number(course.totalQuestions))
        ? Number(course.totalQuestions)
        : state.questionBanks
        .filter((bank) => Number(bank.courseId) === Number(course.id))
        .reduce((total, bank) => total + (Array.isArray(bank.questions) ? bank.questions.length : 0), 0)
    }));
  }

  // Mengambil satu question bank dari state berdasarkan ID di query string.
  function findQuestionBank(questionBankId) {
    return state.questionBanks.find((bank) => Number(bank.id) === Number(questionBankId));
  }

  // Mencari result kandidat dari teacher_applications berdasarkan ID.
  function findApplicationResult(resultId) {
    return state.applications.find((application) => Number(application.id) === Number(resultId));
  }

  // Score belum tersedia sebagai kolom database, jadi fallback dibuat stabil dari urutan data.
  // Jika nanti ada kolom score dari backend, nilai itu akan dipakai otomatis.
  function resultScore(result) {
    if (result.score !== undefined && result.score !== null && result.score !== "") {
      return result.score;
    }

    const sorted = [...state.applications].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    const index = Math.max(0, sorted.findIndex((item) => Number(item.id) === Number(result.id)));
    return [100, 75, 50][index % 3];
  }

  function scoreCellValue(value, fallback = 0) {
    const score = Number(value);
    return Number.isNaN(score) ? fallback : score;
  }

  function finalScoreLabel(result) {
    // Debug: Final Score berasal dari kolom score; setelah Give Score nilainya adalah hasil pembobotan MC + Essay.
    return scoreCellValue(resultScore(result));
  }

  function numericResultScore(result) {
    const score = Number(resultScore(result));
    return Number.isNaN(score) ? 0 : score;
  }

  function resultEducationMatches(bank, result) {
    const resultEducation = String(result.education || "").trim();

    return !resultEducation || courseEducationLevels(bank).some((bankEducation) => (
      bankEducation === resultEducation ||
      `Guru/Karyawan ${bankEducation}` === resultEducation ||
      bankEducation === resultEducation.replace("Guru/Karyawan ", "")
    ));
  }

  function questionBankForResult(result) {
    return state.questionBanks.find((bank) => (
      bank.courseName === result.course && resultEducationMatches(bank, result)
    )) || null;
  }

  function passingScoreForResult(result) {
    const bank = questionBankForResult(result);
    const passingScore = Number(bank?.passingScore);
    return Number.isNaN(passingScore) ? 75 : passingScore;
  }

  function hasPassedResult(result) {
    if (resultNeedsFinalScore(result)) {
      return false;
    }

    return numericResultScore(result) >= passingScoreForResult(result);
  }

  function resultStatusHtml(result) {
    if (resultNeedsFinalScore(result)) {
      return '<span class="status-pill is-waiting">Waiting for Review</span>';
    }

    const passed = hasPassedResult(result);
    return `<span class="status-pill${passed ? "" : " is-draft"}">${passed ? "Passed" : "Not Passed"}</span>`;
  }

  function resultHasEssay(result) {
    if (!result) {
      return false;
    }

    return result.hasEssay || (Array.isArray(result.resultQuestions) && result.resultQuestions.some((question) => question.questionType === "essay"));
  }

  function resultScoreFinalized(result) {
    if (!result) {
      return false;
    }

    // Debug recap/UI: MC-only otomatis final; marker ini hanya wajib untuk test yang punya essay.
    if (!resultHasEssay(result)) {
      return true;
    }

    // Debug: marker finalisasi score disimpan di questions_json agar tidak perlu migrasi tabel.
    return result.weightedScoreFinalized === true || questionsForResult(result).some((question) => question.weightedScoreFinalized === true);
  }

  function resultNeedsFinalScore(result) {
    // MC-only tidak masuk alur review manual; essay menunggu Give Score agar score final tersimpan ke database.
    return resultHasEssay(result) && !resultScoreFinalized(result);
  }

  function multipleChoiceScore(result) {
    if (result.multipleChoiceScore !== undefined && result.multipleChoiceScore !== null && result.multipleChoiceScore !== "") {
      return Number(result.multipleChoiceScore) || 0;
    }

    const questions = questionsForResult(result).filter((question) => question.questionType !== "essay");
    if (!questions.length) {
      return 0;
    }

    const correct = questions.filter((question) => question.isCorrect === true || question.candidateAnswer === question.correctOption).length;
    return Math.round((correct / questions.length) * 100);
  }

  function essayScore(result) {
    const manualEssayScore = questionsForResult(result).find((question) => question.manualEssayScore !== undefined)?.manualEssayScore;
    if (manualEssayScore !== undefined && manualEssayScore !== null && manualEssayScore !== "") {
      return Number(manualEssayScore) || 0;
    }

    if (result.essayScore !== undefined && result.essayScore !== null && result.essayScore !== "") {
      return Number(result.essayScore) || 0;
    }

    const essays = questionsForResult(result).filter((question) => question.questionType === "essay");
    if (!essays.length) {
      return 0;
    }

    const correct = essays.filter((question) => question.isCorrect === true).length;
    return Math.round((correct / essays.length) * 100);
  }

  function sortedResultApplications(applications) {
    const direction = resultSort.direction === "asc" ? 1 : -1;

    return [...applications].sort((a, b) => {
      if (resultSort.key === "name") {
        const comparison = String(a.fullName || "").localeCompare(String(b.fullName || ""), undefined, { sensitivity: "base" });
        return comparison * direction;
      }

      if (resultSort.key === "score") {
        return (numericResultScore(a) - numericResultScore(b)) * direction;
      }

      return (new Date(a.submittedAt) - new Date(b.submittedAt)) * direction;
    });
  }

  function resultSortIcon(key) {
    if (resultSort.key !== key) {
      return "arrow-down";
    }

    return resultSort.direction === "asc" ? "arrow-up" : "arrow-down";
  }

  function resultDateLabel(value) {
    if (!value) {
      return "-";
    }

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(new Date(value.replace(" ", "T")));
  }

  function resultTimeLabel(value) {
    if (!value) {
      return "";
    }

    return `${new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value.replace(" ", "T")))} WIB`;
  }

  function parseDateTime(value) {
    return value ? new Date(String(value).replace(" ", "T")) : null;
  }

  function tokenRemainingSeconds(token = state.activeToken) {
    const expiresAt = parseDateTime(token?.expiresAt);
    return expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)) : 0;
  }

  function updateTokenTimer() {
    const timer = document.querySelector("#tokenTimer");
    const badge = document.querySelector("#tokenStatusBadge");
    if (!timer || !badge) {
      return;
    }

    const remaining = tokenRemainingSeconds();
    timer.textContent = `${remaining}s`;
    badge.textContent = remaining > 0 ? "Active" : "Expired";
    badge.classList.toggle("is-expired", remaining <= 0);
  }

  function startTokenTimer() {
    if (tokenTimerInterval) {
      window.clearInterval(tokenTimerInterval);
      tokenTimerInterval = null;
    }

    if (!state.activeToken) {
      return;
    }

    updateTokenTimer();
    tokenTimerInterval = window.setInterval(() => {
      updateTokenTimer();
      if (tokenRemainingSeconds() <= 0) {
        window.clearInterval(tokenTimerInterval);
        tokenTimerInterval = null;
      }
    }, 1000);
  }

  // Mengambil daftar unik dari data Test Result untuk isi dropdown filter.
  function uniqueResultOptions(key, defaults = []) {
    const serverOptions = Array.isArray(resultServerFilterOptions[key]) ? resultServerFilterOptions[key] : [];
    const values = state.applications
      .map((application) => String(application[key] || "").trim())
      .filter(Boolean);

    return [...new Set([...defaults, ...serverOptions, ...values])].sort((a, b) => a.localeCompare(b));
  }

  function resultFilterOptions(key, placeholder, selectedValue, defaults = []) {
    return [
      `<option value="">${escapeHtml(placeholder)}</option>`,
      ...uniqueResultOptions(key, defaults).map((value) => (
        `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(value)}</option>`
      ))
    ].join("");
  }

  function coursePositionFilterOptions(selectedValue) {
    return [
      '<option value="">All Position</option>',
      ...positionNames().map((value) => (
        `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(value)}</option>`
      ))
    ].join("");
  }

  function positionNameFilterOptions(selectedValue) {
    return [
      '<option value="">All Position Name</option>',
      ...positionNames().map((value) => (
        `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(value)}</option>`
      ))
    ].join("");
  }

  function courseStatusFilterOptions(selectedValue) {
    return [
      '<option value="">All Status</option>',
      `<option value="1"${selectedValue === "1" ? " selected" : ""}>Active</option>`,
      `<option value="0"${selectedValue === "0" ? " selected" : ""}>Inactive</option>`
    ].join("");
  }

  function selectWithChevronHtml(name, optionsHtml, label, extraClass = "") {
    return `
      <label class="filter-inline-field has-chevron ${extraClass}">
        <span class="sr-only">${escapeHtml(label)}</span>
        <select name="${escapeHtml(name)}">
          ${optionsHtml}
        </select>
        <i data-lucide="chevron-down"></i>
      </label>
    `;
  }

  function courseFilterMenuHtml() {
    return `
      <div class="course-filter" id="courseFilter" aria-label="Filter courses">
        <div class="filter-inline-group">
          ${selectWithChevronHtml("position", coursePositionFilterOptions(courseFilterDrafts.position), "Position", "course-filter-field")}
          ${selectWithChevronHtml("status", courseStatusFilterOptions(courseFilterDrafts.status), "Status", "course-status-filter-field")}
          <button class="filter-apply" type="button" data-action="apply-course-filter">Apply</button>
        </div>
      </div>
    `;
  }

  function positionFilterMenuHtml() {
    return `
      <div class="position-filter" id="positionFilter" aria-label="Filter positions">
        <div class="filter-inline-group">
          ${selectWithChevronHtml("name", positionNameFilterOptions(positionFilterDrafts.name), "Position Name", "position-name-filter-field")}
          <button class="filter-apply" type="button" data-action="apply-position-filter">Apply</button>
        </div>
      </div>
    `;
  }

  function sortIcon(direction) {
    return direction === "asc" ? "arrow-up" : "arrow-down";
  }

  function sortedByName(items, direction, getName) {
    const multiplier = direction === "asc" ? 1 : -1;
    return [...items].sort((a, b) => String(getName(a) || "").localeCompare(String(getName(b) || ""), undefined, { sensitivity: "base" }) * multiplier);
  }

  function resultViewToggleHtml() {
    // Toggle ini hanya mengganti data yang diminta ke server; tidak mengubah data test_results.
    return `
      <div class="result-view-toggle" aria-label="Result table mode">
        <button class="${resultViewMode === "results" ? "is-active" : ""}" type="button" data-action="set-result-view" data-view-mode="results">Test Result</button>
        <button class="${resultViewMode === "recap" ? "is-active" : ""}" type="button" data-action="set-result-view" data-view-mode="recap">Recapitulation</button>
      </div>
    `;
  }

  // Tabel hanya menampilkan row yang cocok dengan filter aktif.
  function filteredResultApplications() {
    return state.applications.filter((application) => {
      const matchesCourse = !resultFilters.course || application.course === resultFilters.course;
      const matchesPosition = !resultFilters.education || application.education === resultFilters.education;
      return matchesCourse && matchesPosition;
    });
  }

  // Filter inline: dropdown Course/Position dan satu tombol Apply untuk menerapkan pilihan.
  function resultFilterMenuHtml() {
    return `
      <div class="result-filter" id="resultFilter" aria-label="Filter test results">
        <div class="filter-inline-group">
          ${resultViewToggleHtml()}
          ${selectWithChevronHtml("course", resultFilterOptions("course", "All Course", resultFilterDrafts.course), "Course")}
          ${selectWithChevronHtml("education", resultFilterOptions("education", "All Position", resultFilterDrafts.education, window.RecruitmentStore.educationLevels), "Position")}
          <button class="filter-apply" type="button" data-action="apply-result-filter">Apply</button>
        </div>
      </div>
    `;
  }

  // Render ulang tabel Results tanpa request API baru saat user menerapkan filter.
  function refreshResultsSection() {
    app.innerHTML = `
      ${document.querySelector(".breadcrumb")?.outerHTML || ""}
      ${renderResults()}
    `;

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // Render ulang section tabel aktif tanpa request API baru, dipakai oleh pagination dan filter.
  function refreshTableSection(section = activeSection()) {
    const renderers = {
      course: renderCourses,
      position: renderPositions,
      questions: renderQuestions,
      results: renderResults
    };

    app.innerHTML = `
      ${document.querySelector(".breadcrumb")?.outerHTML || ""}
      ${renderers[section] ? renderers[section]() : ""}
    `;

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // Ambil bank soal yang course dan Position-nya sama dengan hasil test.
  // Jika education tidak tersedia di data lama, pencarian tetap fallback ke nama course.
  function questionsForResult(result) {
    if (Array.isArray(result.resultQuestions) && result.resultQuestions.length > 0) {
      return result.resultQuestions;
    }

    const bank = questionBankForResult(result);
    if (bank && Array.isArray(bank.questions) && bank.questions.length > 0) {
      return bank.questions;
    }

    return [
      { questionText: "What is the result of 245 + 178?", optionA: "413", optionB: "423", optionC: "433", optionD: "453", correctOption: "A" },
      { questionText: "What is 36 / 6?", optionA: "5", optionB: "6", optionC: "7", optionD: "8", correctOption: "B" },
      { questionText: "Which number is the largest?", optionA: "0.5", optionB: "0.05", optionC: "0.15", optionD: "0.25", correctOption: "A" },
      { questionText: "What is 7 x 8?", optionA: "54", optionB: "56", optionC: "58", optionD: "64", correctOption: "B" },
      { questionText: "A rectangle has a length of 10 cm and a width of 5 cm. What is its area?", optionA: "15 cm2", optionB: "30 cm2", optionC: "50 cm2", optionD: "60 cm2", correctOption: "C" },
      { questionText: "What is the value of 3/4 as a decimal?", optionA: "0.25", optionB: "0.5", optionC: "0.75", optionD: "1.25", correctOption: "C" },
      { questionText: "If a clock shows 3:30, what is the angle between the hour and minute hands?", optionA: "45 degrees", optionB: "60 degrees", optionC: "75 degrees", optionD: "90 degrees", correctOption: "C" },
      { questionText: "What is 1000 - 456?", optionA: "534", optionB: "544", optionC: "554", optionD: "564", correctOption: "B" },
      { questionText: "Which fraction is equivalent to 1/2?", optionA: "2/3", optionB: "3/6", optionC: "4/10", optionD: "5/8", correctOption: "B" },
      { questionText: "A student has 24 candies and shares them equally among 6 friends. How many candies does each friend get?", optionA: "2", optionB: "3", optionC: "4", optionD: "5", correctOption: "C" }
    ];
  }

  function paginationState(section, totalItems) {
    const stateForSection = tablePagination[section] || tablePagination.course;
    const totalPages = Math.max(1, Math.ceil(totalItems / stateForSection.pageSize));
    stateForSection.page = Math.min(Math.max(1, stateForSection.page), totalPages);

    return {
      page: stateForSection.page,
      pageSize: stateForSection.pageSize,
      totalPages,
      start: (stateForSection.page - 1) * stateForSection.pageSize,
      end: stateForSection.page * stateForSection.pageSize
    };
  }

  // Nomor pagination dibuat ringkas: halaman awal, sekitar halaman aktif, ellipsis, dan halaman terakhir.
  function paginationPageItems(currentPage, totalPages) {
    if (totalPages <= 5) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
    const sortedPages = [...pages]
      .filter((page) => page >= 1 && page <= totalPages)
      .sort((a, b) => a - b);

    return sortedPages.flatMap((page, index) => {
      const previousPage = sortedPages[index - 1];
      if (index > 0 && page - previousPage > 1) {
        return ["ellipsis", page];
      }
      return [page];
    });
  }

  function tablePageSlice(section, items) {
    const pagination = paginationState(section, items.length);
    return {
      pagination,
      rows: items.slice(pagination.start, pagination.end)
    };
  }

  // Footer pagination aktif untuk Course, Question Bank, dan Test Result.
  function tableFooterHtml(section, totalItems) {
    const pagination = paginationState(section, totalItems);
    const pageItems = paginationPageItems(pagination.page, pagination.totalPages);

    return `
      <div class="table-footer">
        <span>View page:</span>
        <select class="view-select" data-action="change-page-size" data-section-name="${section}" aria-label="Rows per page">
          ${pageSizeOptions.map((size) => `<option value="${size}"${size === pagination.pageSize ? " selected" : ""}>${size}</option>`).join("")}
        </select>
        <button class="pager-btn" type="button" data-action="change-table-page" data-section-name="${section}" data-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""} aria-label="Previous page"><i data-lucide="chevron-left"></i></button>
        ${pageItems.map((item) => item === "ellipsis"
          ? '<span class="pager-ellipsis">...</span>'
          : `<button class="pager-number${item === pagination.page ? " is-active" : ""}" type="button" data-action="change-table-page" data-section-name="${section}" data-page="${item}" ${item === pagination.page ? 'aria-current="page"' : ""}>${item}</button>`
        ).join("")}
        <button class="pager-btn" type="button" data-action="change-table-page" data-section-name="${section}" data-page="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? "disabled" : ""} aria-label="Next page"><i data-lucide="chevron-right"></i></button>
      </div>
    `;
  }

  function courseModeToggleHtml(activeMode = activeCourseMode()) {
    return `
      <div class="course-mode-toggle" aria-label="Course menu mode">
        <button class="${activeMode === "course" ? "is-active" : ""}" type="button" data-action="show-course-table">
          <i data-lucide="book-open"></i>
          <span>Course</span>
        </button>
        <button class="${activeMode === "position" ? "is-active" : ""}" type="button" data-action="show-position-table">
          <i data-lucide="briefcase-business"></i>
          <span>Position</span>
        </button>
      </div>
    `;
  }

  function renderPositions() {
    const allPositionRows = Array.isArray(state.educationLevels) ? state.educationLevels : [];
    const filteredPositions = allPositionRows.filter((position) => !positionFilters.name || position.name === positionFilters.name);
    const allPositions = positionSort.key === "name"
      ? sortedByName(filteredPositions, positionSort.direction, (position) => position.name)
      : filteredPositions;
    const { rows: positions } = tablePageSlice("position", allPositions);
    const rows = positions.map((position) => `
      <tr>
        <td>${escapeHtml(position.name)}</td>
        <td>
          <div class="action-group">
            <button class="icon-btn view" type="button" data-action="view-position" data-id="${position.id}" data-tooltip="View" aria-label="View position"><i data-lucide="eye"></i></button>
            <button class="icon-btn delete" type="button" data-action="delete-position" data-id="${position.id}" data-tooltip="Delete" aria-label="Delete position"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      </tr>
    `).join("");

    return `
      <section class="table-card">
        <div class="table-head">
          <div class="table-title">
            <h1>Position table</h1>
            <span class="count-badge">${allPositions.length} position</span>
          </div>
          <div class="table-head-actions">
            ${positionFilterMenuHtml()}
            ${courseModeToggleHtml("position")}
            <button class="create-btn" type="button" data-action="create-position">
              <span>Add Position</span>
              <i data-lucide="plus"></i>
            </button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 65%;">
                  <button class="sort-header${positionSort.key === "name" ? " is-active" : ""}" type="button" data-action="sort-positions" data-sort-key="name">
                    <span>Position</span>
                    <i class="sort-icon" data-lucide="${positionSort.key === "name" ? sortIcon(positionSort.direction) : "arrow-down"}"></i>
                  </button>
                </th>
                <th style="width: 35%;">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${allPositions.length ? "" : '<div class="empty-state">No positions found for this filter.</div>'}
        ${tableFooterHtml("position", allPositions.length)}
      </section>
    `;
  }

  // Membuat HTML tabel Course dari state.courses.
  function renderCourses() {
    const allCourseRows = coursesWithTotals();
    const allCourses = allCourseRows.filter((course) => {
      const matchesPosition = !courseFilters.position || courseEducationLevels(course).includes(courseFilters.position);
      const matchesStatus = courseFilters.status === "" || String(Number(course.isPublished) === 1 ? 1 : 0) === courseFilters.status;
      return matchesPosition && matchesStatus;
    });
    const sortedCourses = courseSort.key === "name"
      ? sortedByName(allCourses, courseSort.direction, (course) => course.name)
      : allCourses;
    const { rows: courses } = tablePageSlice("course", sortedCourses);
    const rows = courses.map((course) => {
      const isActive = Number(course.isPublished) === 1;
      const toggleAction = isActive ? "inactivate-course" : "activate-course";
      const toggleLabel = isActive ? "Inactivate" : "Activate";
      const toggleIcon = isActive ? "check-circle-2" : "x-circle";

      return `
        <tr>
          <td>${escapeHtml(course.name)}</td>
          <td>${escapeHtml(courseEducationLabel(course))}</td>
          <td>${statusPill(course.isPublished)}</td>
          <td>
            <div class="action-group">
              <button class="icon-btn view" type="button" data-action="view-course" data-id="${course.id}" data-tooltip="View" aria-label="View course"><i data-lucide="eye"></i></button>
              <button class="icon-btn edit" type="button" data-action="edit-course" data-id="${course.id}" data-tooltip="Edit" aria-label="Edit course"><i data-lucide="square-pen"></i></button>
              <button class="icon-btn course-toggle-btn ${isActive ? "toggle-active" : "toggle-inactive"}" type="button" data-action="${toggleAction}" data-id="${course.id}" data-tooltip="${toggleLabel}" aria-label="${toggleLabel} course"><i data-lucide="${toggleIcon}"></i></button>
              <button class="icon-btn delete" type="button" data-action="delete-course" data-id="${course.id}" data-tooltip="Delete" aria-label="Delete course"><i data-lucide="trash-2"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    return `
      <section class="table-card">
        <div class="table-head">
          <div class="table-title">
            <h1>Course table</h1>
            <span class="count-badge">${sortedCourses.length} course</span>
          </div>
          <div class="table-head-actions">
            ${courseFilterMenuHtml()}
            ${courseModeToggleHtml("course")}
            <button class="create-btn" type="button" data-action="create-course">
              <span>Create Course</span>
              <i data-lucide="plus"></i>
            </button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 25%;">
                  <button class="sort-header${courseSort.key === "name" ? " is-active" : ""}" type="button" data-action="sort-courses" data-sort-key="name">
                    <span>Name</span>
                    <i class="sort-icon" data-lucide="${courseSort.key === "name" ? sortIcon(courseSort.direction) : "arrow-down"}"></i>
                  </button>
                </th>
                <th style="width: 25%;">Position</th>
                <th style="width: 20%;">Status</th>
                <th style="width: 30%;">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${sortedCourses.length ? "" : '<div class="empty-state">No courses found for this filter.</div>'}
        ${tableFooterHtml("course", sortedCourses.length)}
      </section>
    `;
  }

  // Membuat halaman Create Course seperti referensi HRIS Dashboard create course.
  // Form ini tidak memakai modal; tampil sebagai halaman penuh di area konten dashboard.
  function renderCreateCoursePage() {
    return `
      <section class="create-course-card">
        <form class="create-course-form" data-form="course-page">
          <div class="create-page-head">
            <button class="back-link" type="button" data-action="back-course" aria-label="Back to course list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>Create Course</h1>
            <div class="create-page-actions">
              <button class="draft-btn" type="submit" name="publishMode" value="0">Save as Draft</button>
              <button class="publish-btn" type="submit" name="publishMode" value="1">
                <span>Publish</span>
                <i data-lucide="plus"></i>
              </button>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Course Name</h2>
              <p>Provide a clear name for this course</p>
            </div>
            <div class="create-form-control">
              <input class="create-input" name="name" type="text" placeholder="Enter the name for the course" required>
              <div class="course-examples">
                <strong>Examples:</strong>
                <span>• Mathematics</span>
                <span>• Science</span>
                <span>• English</span>
              </div>
            </div>
          </div>

          <div class="create-form-row is-description">
            <div class="create-form-copy">
              <h2>Description</h2>
              <p>Add a short description to help others understand this course</p>
            </div>
            <div class="create-form-control">
              <div class="editor-shell">
                ${editorFieldHtml("description", "", "Enter description for the course")}
                ${editorToolbarHtml()}
              </div>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Position</h2>
              <p>Select the Position where this course will be taught</p>
            </div>
            <div class="create-form-control">
              ${educationCheckboxesHtml([])}
            </div>
          </div>
        </form>
      </section>
    `;
  }

  function renderCreatePositionPage() {
    return `
      <section class="create-course-card">
        <form class="create-course-form" data-form="position-page">
          <div class="create-page-head">
            <button class="back-link" type="button" data-action="back-position" aria-label="Back to position list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>Add Position</h1>
            <div class="create-page-actions">
              <button class="publish-btn" type="submit">
                <span>Save</span>
                <i data-lucide="plus"></i>
              </button>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Position Name</h2>
              <p>Create a position option for this admin region</p>
            </div>
            <div class="create-form-control">
              <input class="create-input" name="name" type="text" placeholder="Enter position name" required>
              <div class="course-examples">
                <strong>Examples:</strong>
                <span>&bull; Guru/Karyawan TK</span>
                <span>&bull; Driver</span>
                <span>&bull; Teknisi</span>
              </div>
            </div>
          </div>
        </form>
      </section>
    `;
  }

  function renderViewPositionPage(positionId) {
    const position = findPosition(positionId);

    if (!position) {
      return `
        <section class="view-course-card">
          <div class="view-course-head">
            <button class="back-link" type="button" data-action="back-position" aria-label="Back to position list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>View Position</h1>
          </div>
          <div class="empty-state">Position was not found.</div>
        </section>
      `;
    }

    return `
      <section class="view-course-card">
        <div class="view-course-head">
          <button class="back-link" type="button" data-action="back-position" aria-label="Back to position list">
            <i data-lucide="arrow-left"></i>
          </button>
          <h1>View Position</h1>
          <span class="view-eye" aria-hidden="true"><i data-lucide="eye"></i></span>
        </div>

        <div class="view-course-body">
          <div class="view-field">
            <span>Position Name</span>
            <strong>${escapeHtml(position.name)}</strong>
          </div>

          <div class="view-field">
            <span>Region</span>
            <strong>${escapeHtml(position.regionScope || adminRegion)}</strong>
          </div>
        </div>
      </section>
    `;
  }

  // Halaman Edit Course memakai layout yang sama dengan Create Course, tetapi data lama sudah terisi.
  // Bagian Class dari referensi desain sengaja tidak dibuat sesuai permintaan.
  function renderEditCoursePage(courseId) {
    const course = state.courses.find((item) => Number(item.id) === Number(courseId));

    if (!course) {
      return `
        <section class="create-course-card">
          <div class="create-page-head">
            <button class="back-link" type="button" data-action="back-course" aria-label="Back to course list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>Edit Course</h1>
          </div>
          <div class="empty-state">Course was not found.</div>
        </section>
      `;
    }

    return `
      <section class="create-course-card">
        <form class="create-course-form" data-form="course-page" data-mode="edit" data-id="${course.id}">
          <div class="create-page-head">
            <button class="back-link" type="button" data-action="back-course" aria-label="Back to course list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>Edit Course</h1>
            <div class="create-page-actions">
              <button class="draft-btn" type="submit" name="publishMode" value="0">Save as Draft</button>
              <button class="publish-btn" type="submit" name="publishMode" value="1">
                <span>Save</span>
                <i data-lucide="plus"></i>
              </button>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Course Name</h2>
              <p>Provide a clear name for this course</p>
            </div>
            <div class="create-form-control">
              <input class="create-input" name="name" type="text" value="${escapeHtml(course.name)}" placeholder="Enter the name for the course" required>
              <div class="course-examples">
                <strong>Examples:</strong>
                <span>&bull; Mathematics</span>
                <span>&bull; Science</span>
                <span>&bull; English</span>
              </div>
            </div>
          </div>

          <div class="create-form-row is-description">
            <div class="create-form-copy">
              <h2>Description</h2>
              <p>Add a short description to help others understand this course</p>
            </div>
            <div class="create-form-control">
              <div class="editor-shell">
                ${editorFieldHtml("description", course.description || "", "Enter description for the course")}
                ${editorToolbarHtml()}
              </div>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Position</h2>
              <p>Select the Position where this course will be taught</p>
            </div>
            <div class="create-form-control">
              ${educationCheckboxesHtml(courseEducationLevels(course))}
            </div>
          </div>
        </form>
      </section>
    `;
  }

  // Halaman View Course mengikuti referensi HRIS Dashboard view course dan hanya membaca data.
  function renderViewCoursePage(courseId) {
    const course = state.courses.find((item) => Number(item.id) === Number(courseId));

    if (!course) {
      return `
        <section class="view-course-card">
          <div class="view-course-head">
            <button class="back-link" type="button" data-action="back-course" aria-label="Back to course list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>View Course</h1>
          </div>
          <div class="empty-state">Course was not found.</div>
        </section>
      `;
    }

    return `
      <section class="view-course-card">
        <div class="view-course-head">
          <button class="back-link" type="button" data-action="back-course" aria-label="Back to course list">
            <i data-lucide="arrow-left"></i>
          </button>
          <h1>View Course</h1>
          <span class="view-eye" aria-hidden="true"><i data-lucide="eye"></i></span>
        </div>

        <div class="view-course-body">
          <div class="view-field">
            <span>Course Name</span>
            <strong>${escapeHtml(course.name)}</strong>
          </div>

          <div class="view-field">
            <span>Description</span>
            <strong>${richTextHtml(course.description || "-")}</strong>
          </div>

          <div class="view-field">
            <span>Position</span>
            <strong>${escapeHtml(courseEducationLabel(course))}</strong>
          </div>
        </div>
      </section>
    `;
  }

  // Membuat HTML tabel Question Bank dari tabel aktif question_banks.
  function renderQuestions() {
    // List sekarang memakai tabel question_banks: satu baris mewakili satu bank soal.
    const allQuestionBankRows = state.questionBanks.map((bank) => ({
      id: bank.id,
      subject: bank.courseName,
      isPublished: bank.isPublished,
      passingScore: bank.passingScore || "75",
      questionCount: Number.isFinite(Number(bank.questionCount)) ? Number(bank.questionCount) : (bank.questions || []).length
    }));
    const { rows: questionBankRows } = tablePageSlice("questions", allQuestionBankRows);

    const rows = questionBankRows.map((item) => {
      const isPublished = Number(item.isPublished) === 1;
      const toggleAction = isPublished ? "unpublish-question-bank" : "publish-question-bank";
      const toggleLabel = isPublished ? "Inactivate" : "Activate";
      const toggleIcon = isPublished ? "check-circle-2" : "x-circle";

      return `
        <tr>
          <td>${escapeHtml(item.subject)}</td>
          <td>${questionBankStatusPill(item.isPublished)}</td>
          <td>${escapeHtml(item.passingScore)}</td>
          <td>
            <div class="action-group">
              <button class="icon-btn view" type="button" data-action="view-question-bank" data-id="${item.id}" data-tooltip="View" aria-label="View question bank"><i data-lucide="eye"></i></button>
              <button class="icon-btn edit" type="button" data-action="edit-question-bank" data-id="${item.id}" data-tooltip="Edit" aria-label="Edit question bank"><i data-lucide="square-pen"></i></button>
              <button class="icon-btn course-toggle-btn ${isPublished ? "toggle-active" : "toggle-inactive"}" type="button" data-action="${toggleAction}" data-id="${item.id}" data-tooltip="${toggleLabel}" aria-label="${toggleLabel} question bank"><i data-lucide="${toggleIcon}"></i></button>
              <button class="icon-btn delete" type="button" data-action="delete-question-bank" data-id="${item.id}" data-tooltip="Delete" aria-label="Delete question bank"><i data-lucide="trash-2"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    return `
      <section class="table-card question-bank-card">
        <div class="table-head">
          <div class="table-title">
            <h1>Question Bank</h1>
            <span class="count-badge">${allQuestionBankRows.length} test results</span>
          </div>
          <button class="create-btn" type="button" data-action="create-question">
            <span>Create Question Bank</span>
            <i data-lucide="plus"></i>
          </button>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 32%;">Subject</th>
                <th style="width: 18%;">Status</th>
                <th style="width: 18%;">Passing Score</th>
                <th style="width: 32%;">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${allQuestionBankRows.length ? "" : '<div class="empty-state">No question bank data found.</div>'}
        ${tableFooterHtml("questions", allQuestionBankRows.length)}
      </section>
    `;
  }

  // Membuat HTML tabel hasil submit pelamar dari state.applications.
  function renderResults() {
    if (resultViewMode === "recap") {
      return renderRecapitulations();
    }

    // Results memakai server-side pagination; state.applications hanya berisi halaman aktif.
    const totalApplications = resultServerTotal || state.applications.length;
    const applications = state.applications;
    const rows = applications.map((result) => {
      const hasEssay = resultHasEssay(result);
      const reviewDisabled = !hasEssay;
      const scoreDisabled = !hasEssay;
      const reviewTooltip = !hasEssay ? "No Essay" : "Review Essay";
      const scoreTooltip = !hasEssay ? "No Essay" : resultScoreFinalized(result) ? "Update Score" : "Give Score";

      return `
        <tr>
          <td>${escapeHtml(result.fullName)}</td>
          <td class="result-email-cell">${escapeHtml(result.email)}</td>
          <td>${escapeHtml(result.phone)}</td>
          <td>${escapeHtml(result.education || "-")}</td>
          <td>${escapeHtml(result.course)}</td>
          <td>${escapeHtml(finalScoreLabel(result))}</td>
          <td>${escapeHtml(multipleChoiceScore(result))}</td>
          <td>${escapeHtml(resultHasEssay(result) ? essayScore(result) : "-")}</td>
          <td>
            <span class="result-date-cell">${resultDateLabel(result.submittedAt)}</span>
            <small>${resultTimeLabel(result.submittedAt)}</small>
          </td>
          <td>
            <div class="action-group result-actions">
              <button class="icon-btn review" type="button" data-action="review-essay-result" data-id="${result.id}" data-tooltip="${reviewTooltip}" aria-label="Review essay"${reviewDisabled ? " disabled" : ""}><i data-lucide="clipboard-check"></i></button>
              <button class="icon-btn score" type="button" data-action="give-essay-score" data-id="${result.id}" data-tooltip="${scoreTooltip}" aria-label="Give essay score"${scoreDisabled ? " disabled" : ""}><i data-lucide="badge-check"></i></button>
              <button class="icon-btn view" type="button" data-action="view-test-result" data-id="${result.id}" data-tooltip="View" aria-label="View test result"><i data-lucide="eye"></i></button>
              <button class="icon-btn delete" type="button" data-action="delete-application" data-id="${result.id}" data-tooltip="Delete" aria-label="Delete test result"><i data-lucide="trash-2"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    return `
      <section class="table-card result-table-card">
        <div class="table-head">
          <div class="table-title">
            <h1>Test Result Table</h1>
            <span class="count-badge">${totalApplications} test results</span>
          </div>
          <div class="toolbar result-toolbar">
            ${resultFilterMenuHtml()}
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table result-table">
            <thead>
              <tr>
                <th style="width: 20%;">
                  <button class="sort-header${resultSort.key === "name" ? " is-active" : ""}" type="button" data-action="sort-results" data-sort-key="name">
                    <span>Name</span>
                    <i class="sort-icon" data-lucide="${resultSortIcon("name")}"></i>
                  </button>
                </th>
                <th>Email</th>
                <th>Phone Number</th>
                <th>Position</th>
                <th>Course</th>
                <th>
                  <button class="sort-header${resultSort.key === "score" ? " is-active" : ""}" type="button" data-action="sort-results" data-sort-key="score">
                    <span>Final Score</span>
                    <i class="sort-icon" data-lucide="${resultSortIcon("score")}"></i>
                  </button>
                </th>
                <th>Multiple Choice Score</th>
                <th>Essay Score</th>
                <th>Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${totalApplications ? "" : '<div class="empty-state">No application results found for the selected filter.</div>'}
        ${tableFooterHtml("results", totalApplications)}
      </section>
    `;
  }

  function recapStatusHtml(status) {
    if (status === "Waiting for Review") {
      return '<span class="status-pill is-waiting">Waiting for Review</span>';
    }

    return `<span class="status-pill${status === "Passed" ? "" : " is-draft"}">${escapeHtml(status || "Not Passed")}</span>`;
  }

  function renderRecapitulations() {
    const totalRecaps = recapServerTotal || recapitulations.length;
    const rows = recapitulations.map((recap) => {
      const passed = recap.status === "Passed";

      return `
        <tr>
          <td>${escapeHtml(recap.fullName)}</td>
          <td class="result-email-cell">${escapeHtml(recap.email)}</td>
          <td>${escapeHtml(recap.phone)}</td>
          <td>${escapeHtml(recap.education || "-")}</td>
          <td>${escapeHtml(recap.course || "-")}</td>
          <td>${escapeHtml(recap.score)}</td>
          <td>${recapStatusHtml(recap.status)}</td>
          <td>
            <div class="action-group result-actions">
              <button class="icon-btn view" type="button" data-action="view-recapitulation" data-recap-id="${escapeHtml(recap.id)}" data-tooltip="View" aria-label="View recapitulation detail"><i data-lucide="eye"></i></button>
              <button class="icon-btn email" type="button" data-action="send-recap-email" data-id="${escapeHtml(recap.id)}" data-email="${escapeHtml(recap.email)}" data-tooltip="${passed ? "Email" : "Only Passed"}" aria-label="Email candidate"${passed ? "" : " disabled"}><i data-lucide="mail"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    return `
      <section class="table-card result-table-card">
        <div class="table-head">
          <div class="table-title">
            <h1>Test Recapitulation Table</h1>
            <span class="count-badge">${totalRecaps} participants</span>
          </div>
          <div class="toolbar result-toolbar">
            ${resultFilterMenuHtml()}
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table result-table">
            <thead>
              <tr>
                <th style="width: 20%;">
                  <button class="sort-header${resultSort.key === "name" ? " is-active" : ""}" type="button" data-action="sort-results" data-sort-key="name">
                    <span>Name</span>
                    <i class="sort-icon" data-lucide="${resultSortIcon("name")}"></i>
                  </button>
                </th>
                <th>Email</th>
                <th>Phone Number</th>
                <th>Position</th>
                <th>Course</th>
                <th>
                  <button class="sort-header${resultSort.key === "score" ? " is-active" : ""}" type="button" data-action="sort-results" data-sort-key="score">
                    <span>Score</span>
                    <i class="sort-icon" data-lucide="${resultSortIcon("score")}"></i>
                  </button>
                </th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${totalRecaps ? "" : '<div class="empty-state">No recapitulation data found for the selected filter.</div>'}
        ${tableFooterHtml("results", totalRecaps)}
      </section>
    `;
  }

  function renderExamToken() {
    const activeToken = state.activeToken;
    const tokenValue = activeToken ? String(activeToken.token || "") : "----";
    const tokenCreatedAt = activeToken ? dateLabel(activeToken.createdAt) : "No active token yet";
    const tokenExpiresAt = activeToken ? dateLabel(activeToken.expiresAt) : "-";
    const remainingSeconds = tokenRemainingSeconds(activeToken);

    return `
      <section class="table-card token-card">
        <div class="table-head">
          <div class="table-title">
            <h1>Exam Token</h1>
            <span class="count-badge${activeToken ? "" : " is-expired"}" id="tokenStatusBadge">${activeToken ? "Active" : "Not generated"}</span>
          </div>
          <div class="toolbar">
            <button class="primary-btn" type="button" data-action="generate-exam-token">
              <i data-lucide="refresh-cw"></i>
              <span>Generate Token</span>
            </button>
          </div>
        </div>

        <div class="token-panel">
          <div class="token-display" aria-label="Active exam token">
            ${escapeHtml(tokenValue)}
          </div>
          <div class="token-meta">
            <span>Current active token</span>
            <strong>${escapeHtml(tokenCreatedAt)}</strong>
            <div class="token-expiry">
              <span>Expires at</span>
              <strong>${escapeHtml(tokenExpiresAt)}</strong>
            </div>
            <div class="token-timer" aria-label="Token countdown">
              <span>Time left</span>
              <strong id="tokenTimer">${remainingSeconds}s</strong>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  // Halaman View Test Results mengikuti referensi: detail kandidat lalu daftar pertanyaan.
  function renderViewTestResultPage(resultId) {
    const result = findApplicationResult(resultId);

    if (!result) {
      return `
        <section class="view-course-card">
          <div class="view-course-head">
            <button class="back-link" type="button" data-action="back-results" aria-label="Back to test result list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>View Test Results</h1>
          </div>
          <div class="empty-state">Test result was not found.</div>
        </section>
      `;
    }

    const questions = questionsForResult(result);

    return `
      <section class="view-course-card view-test-result-card">
        <div class="view-course-head">
          <button class="back-link" type="button" data-action="back-results" aria-label="Back to test result list">
            <i data-lucide="arrow-left"></i>
          </button>
          <h1>View Test Results</h1>
          <button class="download-result-btn" type="button" data-action="export-results">Download as .xlx</button>
        </div>

        <div class="view-course-body test-result-detail">
          <div class="view-field">
            <span>Name</span>
            <strong>${escapeHtml(result.fullName)}</strong>
          </div>
          <div class="view-field">
            <span>Email</span>
            <strong>${escapeHtml(result.email)}</strong>
          </div>
          <div class="view-field">
            <span>Phone Number</span>
            <strong>${escapeHtml(result.phone)}</strong>
          </div>
          <div class="view-field">
            <span>Region</span>
            <strong>${escapeHtml(result.region || "-")}</strong>
          </div>
          <div class="view-field">
            <span>Position</span>
            <strong>${escapeHtml(result.education || "-")}</strong>
          </div>
          <div class="view-field">
            <span>Course</span>
            <strong>${escapeHtml(result.course)}</strong>
          </div>
          <div class="view-field">
            <span>Final Score</span>
            <strong>${escapeHtml(finalScoreLabel(result))}</strong>
          </div>
          <div class="view-field">
            <span>Multiple Choice Score</span>
            <strong>${escapeHtml(multipleChoiceScore(result))}</strong>
          </div>
          <div class="view-field">
            <span>Essay Score</span>
            <strong>${escapeHtml(resultHasEssay(result) ? essayScore(result) : "-")}</strong>
          </div>
          
          <div class="view-field">
            <span>Date</span>
            <strong>${resultDateLabel(result.submittedAt)}; ${resultTimeLabel(result.submittedAt)}</strong>
          </div>
        </div>
      </section>

      <section class="test-question-card">
        <div class="test-question-head">
          <h2>Question</h2>
        </div>
        <div class="test-question-list">
          ${questions.map((question, index) => resultQuestionHtml(question, index + 1)).join("")}
        </div>
      </section>
    `;
  }

  function renderViewRecapitulationPage() {
    const recap = activeRecapitulation;

    if (!recap) {
      return `
        <section class="view-course-card">
          <div class="view-course-head">
            <button class="back-link" type="button" data-action="back-results" aria-label="Back to recapitulation list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>View Test Recapitulation</h1>
          </div>
          <div class="empty-state">Recapitulation detail was not found.</div>
        </section>
      `;
    }

    const resultSections = (recap.results || []).map((result, resultIndex) => {
      const questions = questionsForResult(result);

      return `
        <section class="test-question-card">
          <div class="test-question-head">
            <h2>Test Result ${resultIndex + 1} - ${escapeHtml(result.course || "-")}</h2>
          </div>
          <div class="view-course-body test-result-detail">
            <div class="view-field">
              <span>Final Score</span>
              <strong>${escapeHtml(finalScoreLabel(result))}</strong>
            </div>
            <div class="view-field">
              <span>Passing Grade</span>
              <strong>${escapeHtml(result.passingScore ?? "-")}</strong>
            </div>
            <div class="view-field">
              <span>Multiple Choice Score</span>
              <strong>${escapeHtml(multipleChoiceScore(result))}</strong>
            </div>
            <div class="view-field">
              <span>Essay Score</span>
              <strong>${escapeHtml(resultHasEssay(result) ? essayScore(result) : "-")}</strong>
            </div>
            <div class="view-field">
              <span>Position</span>
              <strong>${escapeHtml(result.education || "-")}</strong>
            </div>
            <div class="view-field">
              <span>Date</span>
              <strong>${resultDateLabel(result.submittedAt)}; ${resultTimeLabel(result.submittedAt)}</strong>
            </div>
          </div>
          <div class="test-question-list">
            ${questions.length ? questions.map((question, index) => resultQuestionHtml(question, index + 1)).join("") : '<div class="empty-state">No question detail found for this result.</div>'}
          </div>
        </section>
      `;
    }).join("");

    return `
      <section class="view-course-card view-test-result-card">
        <div class="view-course-head">
          <button class="back-link" type="button" data-action="back-results" aria-label="Back to recapitulation list">
            <i data-lucide="arrow-left"></i>
          </button>
          <h1>View Test Recapitulation</h1>
        </div>

        <div class="view-course-body test-result-detail">
          <div class="view-field">
            <span>Name</span>
            <strong>${escapeHtml(recap.fullName)}</strong>
          </div>
          <div class="view-field">
            <span>Email</span>
            <strong>${escapeHtml(recap.email)}</strong>
          </div>
          <div class="view-field">
            <span>Phone Number</span>
            <strong>${escapeHtml(recap.phone)}</strong>
          </div>
          <div class="view-field">
            <span>Position</span>
            <strong>${escapeHtml(recap.education || "-")}</strong>
          </div>
          <div class="view-field">
            <span>Course</span>
            <strong>${escapeHtml(recap.course || "-")}</strong>
          </div>
          <div class="view-field">
            <span>Average Score</span>
            <strong>${escapeHtml(recap.score)}</strong>
          </div>
          <div class="view-field">
            <span>Average Passing Grade</span>
            <strong>${escapeHtml(recap.passingScore)}</strong>
          </div>
          <div class="view-field">
            <span>Status</span>
            <strong>${recapStatusHtml(recap.status)}</strong>
          </div>
          <div class="view-field">
            <span>Total Test</span>
            <strong>${escapeHtml(recap.testCount)}</strong>
          </div>
        </div>
      </section>

      <div class="recap-result-stack">
        ${resultSections || '<section class="test-question-card"><div class="empty-state">No test result detail found.</div></section>'}
      </div>
    `;
  }

  function renderReviewEssayPage(resultId) {
    const result = findApplicationResult(resultId);
    if (!result) {
      return '<section class="view-course-card"><div class="empty-state">Test result was not found.</div></section>';
    }

    const essayQuestions = questionsForResult(result).filter((question) => question.questionType === "essay");
    if (!essayReviewDraft || Number(essayReviewDraft.resultId) !== Number(resultId)) {
      essayReviewDraft = {
        resultId,
        page: 1,
        pageSize: 5,
        reviews: essayQuestions.map((question) => question.isCorrect === true)
      };
    }

    const pageSize = essayReviewDraft.pageSize || 5;
    const totalPages = Math.max(1, Math.ceil(essayQuestions.length / pageSize));
    essayReviewDraft.page = Math.min(Math.max(1, essayReviewDraft.page || 1), totalPages);
    const startIndex = (essayReviewDraft.page - 1) * pageSize;
    const visibleQuestions = essayQuestions.slice(startIndex, startIndex + pageSize);
    return `
      <section class="test-question-card">
        <div class="test-question-head">
          <button class="back-link" type="button" data-action="back-results" aria-label="Back to test result list">
            <i data-lucide="arrow-left"></i>
          </button>
          <h2>Review Essay - ${escapeHtml(result.fullName)}</h2>
          <button class="secondary-btn review-pdf-btn" type="button" data-action="download-review-essay-pdf" data-id="${result.id}">
            <i data-lucide="download"></i>
            <span>Download as PDF</span>
          </button>
        </div>
        <div class="test-question-list">
          ${essayQuestions.length ? visibleQuestions.map((question, index) => {
            const reviewIndex = startIndex + index;
            return essayReviewHtml(question, reviewIndex + 1, {
              reviewIndex,
              reviewValue: essayReviewDraft.reviews[reviewIndex] === true,
              editable: true
            });
          }).join("") : '<div class="empty-state">No essay answers found.</div>'}
          ${essayQuestions.length ? essayReviewPaginationHtml(totalPages, essayReviewDraft.page, essayReviewDraft.pageSize) : ""}
        </div>
      </section>
    `;
  }

  function essayReviewPaginationHtml(totalPages, activePage, pageSize) {
    return `
      <div class="essay-review-footer">
        <label class="essay-review-view">
          <span>View page:</span>
          <select data-action="essay-review-page-size">
            ${[5, 10, 25, 50].map((size) => `<option value="${size}"${Number(pageSize) === size ? " selected" : ""}>${size}</option>`).join("")}
          </select>
        </label>
        <button class="pager-btn" type="button" data-action="essay-review-prev"${activePage <= 1 ? " disabled" : ""} aria-label="Previous page"><i data-lucide="chevron-left"></i></button>
        <div class="view-question-pagination essay-review-pages">
          ${Array.from({ length: totalPages }, (_, index) => `
            <button class="question-page-btn${activePage === index + 1 ? " is-active" : ""}" type="button" data-action="essay-review-page" data-page="${index + 1}">
              ${index + 1}
            </button>
          `).join("")}
        </div>
        <button class="pager-btn" type="button" data-action="essay-review-next"${activePage >= totalPages ? " disabled" : ""} aria-label="Next page"><i data-lucide="chevron-right"></i></button>
      </div>
    `;
  }

  // Render utama: ambil data dari API, tentukan section aktif, lalu tampilkan tabel yang sesuai.
  async function render() {
    const section = activeSection();
    const action = activeAction();
    const recordId = activeId();
    pageTitle.textContent = section === "course" && activeCourseMode(section, action) === "position" ? "Position List" : sectionTitles[section];
    app.innerHTML = '<div class="empty-state">Loading data from database...</div>';

    try {
      await loadStateForRoute(section, action, recordId);
    } catch (error) {
      app.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Unable to load dashboard data.")}</div>`;
      return;
    }

    document.querySelectorAll("[data-section]").forEach((link) => {
      link.classList.toggle("is-active", link.dataset.section === section);
    });

    // Breadcrumb menyesuaikan mode create course agar sama seperti referensi desain.
    const breadcrumbHtml = section === "course" && action === "create"
      ? `
        <div class="breadcrumb">
          <span>Course</span>
          <i data-lucide="chevron-right"></i>
          <span>Course List</span>
          <i data-lucide="chevron-right"></i>
          <span style="color:black">Create Course</span>
        </div>
      `
      : section === "course" && action === "positions"
        ? `
          <div class="breadcrumb">
            <span>Course</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">Position List</span>
          </div>
        `
      : section === "course" && action === "position-create"
        ? `
          <div class="breadcrumb">
            <span>Course</span>
            <i data-lucide="chevron-right"></i>
            <span>Position List</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">Add Position</span>
          </div>
        `
      : section === "course" && action === "position-view"
        ? `
          <div class="breadcrumb">
            <span>Course</span>
            <i data-lucide="chevron-right"></i>
            <span>Position List</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">View Position</span>
          </div>
        `
      : section === "course" && action === "view"
        ? `
          <div class="breadcrumb">
            <span>Course</span>
            <i data-lucide="chevron-right"></i>
            <span>Course List</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">View Course</span>
          </div>
        `
      : section === "course" && action === "edit"
        ? `
          <div class="breadcrumb">
            <span>Course</span>
            <i data-lucide="chevron-right"></i>
            <span>Course List</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">Edit Course</span>
          </div>
        `
      : section === "questions"
        ? `
          <div class="breadcrumb">
  <span style="${action !== 'create' ? '' : ''}">
    Question Management
  </span>

  ${
    action === "create"
      ? `
        <i data-lucide="chevron-right"></i>

        <span>Question Bank</span>

        <i data-lucide="chevron-right"></i>

        <span style="color:black;">
          Create Question Bank
        </span>
      `
      : action === "view"
      ? `
        <i data-lucide="chevron-right"></i>

        <span>Question Bank</span>

        <i data-lucide="chevron-right"></i>

        <span style="color:black;">
          View Question Bank
        </span>
      `
      : action === "edit"
      ? `
        <i data-lucide="chevron-right"></i>

        <span>Question Bank</span>

        <i data-lucide="chevron-right"></i>

        <span style="color:black;">
          Edit Question Bank
        </span>
      `
      : `
        <i data-lucide="chevron-right"></i>

        <span style="color:black;">
          Question Bank
        </span>
      `
  }
</div>
        `
      : section === "results" && action === "recap-view"
        ? `
          <div class="breadcrumb">
            <span>Test Results</span>
            <i data-lucide="chevron-right"></i>
            <span>Recapitulation</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">View Test Recapitulation</span>
          </div>
        `
      : section === "results" && action === "view"
        ? `
          <div class="breadcrumb">
            <span>Test Results</span>
            <i data-lucide="chevron-right"></i>
            <span>History</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">View Test Results</span>
          </div>
        `
      : section === "results"
        ? `
          <div class="breadcrumb">
            <span>Test Results</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">History</span>
          </div>
        `
      : section === "token"
        ? `
          <div class="breadcrumb">
            <span>Exam & Results</span>
            <i data-lucide="chevron-right"></i>
            <span style="color:black">Exam Token</span>
          </div>
        `
      : `
        <div class="breadcrumb">
          <span>${section === "results" ? "Exam & Results" : "Question Management"}</span>
          <i data-lucide="chevron-right"></i>
          <span style="color:black">${sectionTitles[section]}</span>
        </div>
      `;

    app.innerHTML = `
      ${breadcrumbHtml}
      ${section === "course" && action === "create" ? renderCreateCoursePage() : ""}
      ${section === "course" && action === "edit" ? renderEditCoursePage(recordId) : ""}
      ${section === "course" && action === "view" ? renderViewCoursePage(recordId) : ""}
      ${section === "course" && action === "positions" ? renderPositions() : ""}
      ${section === "course" && action === "position-create" ? renderCreatePositionPage() : ""}
      ${section === "course" && action === "position-view" ? renderViewPositionPage(recordId) : ""}
      ${section === "course" && !["create", "edit", "view", "positions", "position-create", "position-view"].includes(action) ? renderCourses() : ""}
      ${section === "questions" && action === "create" ? renderCreateQuestionBankPage() : ""}
      ${section === "questions" && action === "edit" ? renderEditQuestionBankPage(recordId) : ""}
      ${section === "questions" && action === "view" ? renderViewQuestionBankPage(recordId) : ""}
      ${section === "questions" && action !== "create" && action !== "edit" && action !== "view" ? renderQuestions() : ""}
      ${section === "results" && action === "recap-view" ? renderViewRecapitulationPage() : ""}
      ${section === "results" && action === "view" ? renderViewTestResultPage(recordId) : ""}
      ${section === "results" && action === "review" ? renderReviewEssayPage(recordId) : ""}
      ${section === "results" && action !== "recap-view" && action !== "view" && action !== "review" ? renderResults() : ""}
      ${section === "token" ? renderExamToken() : ""}
    `;

    if (window.lucide) {
      window.lucide.createIcons();
    }
    if (section === "token") {
      startTokenTimer();
    }
  }

  // Opsi Position untuk modal Course.
  function educationOptions(selectedValue) {
    return positionNames().map((level) => {
      return `<option value="${escapeHtml(level)}"${level === selectedValue ? " selected" : ""}>${escapeHtml(level)}</option>`;
    }).join("");
  }

  function educationCheckboxesHtml(selectedValues = []) {
    const selected = new Set(selectedValues);
    const label = selectedValues.length ? selectedValues.join(", ") : "Select Position for the Course";
    const levels = positionNames();
    return `
      <div class="position-multiselect" data-position-multiselect>
        <button class="position-multiselect-toggle" type="button" data-action="toggle-position-dropdown" aria-expanded="false">
          <span data-position-label>${escapeHtml(label)}</span>
          <i data-lucide="chevron-down"></i>
        </button>
        <div class="position-multiselect-menu" role="group" aria-label="Select positions for this course">
          ${levels.length ? levels.map((level) => `
            <label class="position-checkbox">
              <input type="checkbox" name="educationLevels" value="${escapeHtml(level)}"${selected.has(level) ? " checked" : ""}>
              <span>${escapeHtml(level)}</span>
            </label>
          `).join("") : '<div class="position-empty-note">Add a position first for this region.</div>'}
        </div>
      </div>
    `;
  }

  function updatePositionDropdownLabel(root) {
    const selected = [...root.querySelectorAll('input[name="educationLevels"]:checked')]
      .map((input) => input.value);
    const label = root.querySelector("[data-position-label]");
    if (label) {
      label.textContent = selected.length ? selected.join(", ") : "Select Position for the Course";
    }
  }

  function closePositionDropdowns(exceptRoot = null) {
    document.querySelectorAll("[data-position-multiselect]").forEach((root) => {
      if (root === exceptRoot) {
        return;
      }

      root.classList.remove("is-open");
      root.querySelector("[data-action='toggle-position-dropdown']")?.setAttribute("aria-expanded", "false");
    });
  }

  // Wrapper modal. Saat ini hanya dipakai untuk fallback modal lama seperti courseModal.
  function openModal(title, body, isReadOnly) {
    modalContent.innerHTML = `
      <div class="form-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-head">
          <h2 id="modalTitle">${escapeHtml(title)}</h2>
          <button class="modal-close" type="button" data-action="close-modal" aria-label="Close"><i data-lucide="x"></i></button>
        </div>
        ${body}
      </div>
    `;
    modalLayer.classList.add("is-open");
    modalLayer.dataset.readonly = isReadOnly ? "1" : "0";

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // Menutup modal dan membuang isinya supaya form lama tidak tertinggal.
  function closeModal() {
    modalLayer.classList.remove("is-open");
    modalContent.innerHTML = "";
  }

  // Membuka modal create/view/edit course. Mode menentukan field bisa diedit atau read-only.
  function courseModal(mode, id) {
    const course = state.courses.find((item) => Number(item.id) === Number(id)) || {
      id: "",
      name: "",
      description: "",
      educationLevel: "",
      isPublished: 1
    };
    const isReadOnly = mode === "view";
    const title = mode === "create" ? "Create Course" : mode === "edit" ? "Edit Course" : "View Course";

    openModal(title, `
      <form class="admin-form" data-form="course" data-mode="${mode}" data-id="${course.id}">
        <div class="form-grid">
          <div class="field">
            <label for="courseName">Course Name</label>
            <input id="courseName" name="name" type="text" value="${escapeHtml(course.name)}" ${isReadOnly ? "disabled" : "required"}>
          </div>
          <div class="field">
            <label for="courseEducation">Position</label>
            ${educationCheckboxesHtml(courseEducationLevels(course))}
          </div>
          <div class="field">
            <label for="courseStatus">Status</label>
            <select id="courseStatus" name="isPublished" ${isReadOnly ? "disabled" : ""}>
              <option value="1"${Number(course.isPublished) === 1 ? " selected" : ""}>Published</option>
              <option value="0"${Number(course.isPublished) === 0 ? " selected" : ""}>Draft</option>
            </select>
          </div>
          <div class="field is-wide">
            <label for="courseDescription">Description</label>
            <textarea id="courseDescription" name="description" ${isReadOnly ? "disabled" : ""}>${escapeHtml(course.description)}</textarea>
          </div>
        </div>
        <div class="form-actions">
          <button class="secondary-btn" type="button" data-action="close-modal">Cancel</button>
          ${isReadOnly ? "" : '<button class="primary-btn" type="submit">Save Course</button>'}
        </div>
      </form>
    `, isReadOnly);
  }

  // Opsi dropdown course pada Question Bank hanya berisi course aktif.
  // Position tidak dipilih di sini karena sudah melekat pada Course.
  function questionBankCourseOptions(selectedId = "") {
    const activeCourses = state.courses.filter((course) => {
      const isAllowedStatus = Number(course.isPublished) === 1 || Number(course.id) === Number(selectedId);
      return isAllowedStatus;
    });
    return activeCourses.map((course) => {
      const label = course.name;
      return `<option value="${course.id}"${Number(course.id) === Number(selectedId) ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
  }

  // Draft default berisi satu soal. User bisa menambah soal lewat tombol (+) pagination.
  function createEmptyQuestionDraft() {
    return {
      questionType: "multiple_choice",
      questionText: "",
      optionA: "",
      optionB: "",
      optionC: "",
      optionD: "",
      correctOption: "",
      imageData: "",
      imageName: ""
    };
  }

  function ensureQuestionBankDraft() {
    if (!questionBankDraft) {
      questionBankDraft = {
        id: "",
        courseId: "",
        passingScore: "",
        isPublished: 1,
        isRandomized: 1,
        importPreview: null,
        mode: "create",
        activeIndex: 0,
        pagerStart: 0,
        questions: [createEmptyQuestionDraft()]
      };
    }

    return questionBankDraft;
  }

  // Mengubah data question bank dari database menjadi draft yang bisa diedit oleh form.
  function loadQuestionBankDraft(bank) {
    const questions = Array.isArray(bank.questions) && bank.questions.length
      ? bank.questions.map((question) => ({
        questionType: question.questionType === "essay" ? "essay" : "multiple_choice",
        questionText: question.questionText || "",
        optionA: question.optionA || "",
        optionB: question.optionB || "",
        optionC: question.optionC || "",
        optionD: question.optionD || "",
        correctOption: question.correctOption || "",
        imageData: question.imageData || "",
        imageName: question.imageName || ""
      }))
      : [createEmptyQuestionDraft()];

    questionBankDraft = {
      id: bank.id,
      courseId: bank.courseId,
      passingScore: bank.passingScore || "",
      isPublished: Number(bank.isPublished) === 1 ? 1 : 0,
      isRandomized: Number(bank.isRandomized) === 1 ? 1 : 0,
      importPreview: null,
      mode: "edit",
      activeIndex: 0,
      pagerStart: 0,
      questions
    };

    return questionBankDraft;
  }

  // Menyimpan isi form soal aktif ke draft sebelum user pindah halaman soal.
  function syncActiveQuestionDraft() {
    const form = document.querySelector('[data-form="question-bank-page"]');
    if (!form || !questionBankDraft) {
      return;
    }

    syncAllEditors(form);
    const activeQuestion = questionBankDraft.questions[questionBankDraft.activeIndex];
    questionBankDraft.courseId = form.elements.courseId.value;
    questionBankDraft.passingScore = form.elements.passingScore.value;
    questionBankDraft.isRandomized = form.elements.isRandomized ? Number(form.elements.isRandomized.value) : 1;
    activeQuestion.questionText = form.elements.questionText.value;
    activeQuestion.questionType = form.elements.questionType ? form.elements.questionType.value : "multiple_choice";
    activeQuestion.optionA = form.elements.optionA ? form.elements.optionA.value : activeQuestion.optionA;
    activeQuestion.optionB = form.elements.optionB ? form.elements.optionB.value : activeQuestion.optionB;
    activeQuestion.optionC = form.elements.optionC ? form.elements.optionC.value : activeQuestion.optionC;
    activeQuestion.optionD = form.elements.optionD ? form.elements.optionD.value : activeQuestion.optionD;
    activeQuestion.correctOption = form.elements.correctOption ? form.elements.correctOption.value : activeQuestion.correctOption;
  }

  function questionImageUploadHtml(question) {
    const hasImage = isQuestionImageDataUrl(question.imageData);
    return `
      <div class="question-image-upload">
        <label class="question-image-drop">
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-question-image-input>
          <span class="question-image-drop-icon"><i data-lucide="image-plus"></i></span>
          <span>${hasImage ? "Change image" : "Attach image"}</span>
        </label>
        ${hasImage ? `
          <button class="secondary-btn question-image-remove" type="button" data-action="remove-question-image">
            <i data-lucide="trash-2"></i>
            <span>Remove image</span>
          </button>
        ` : ""}
        <p>PNG, JPG, GIF, or WEBP. Max 2 MB per question.</p>
        ${questionImageHtml(question)}
      </div>
    `;
  }

  function questionTypeControlHtml(question) {
    const type = question.questionType === "essay" ? "essay" : "multiple_choice";
    return `
      <div class="question-type-toggle">
        <label class="${type === "multiple_choice" ? "is-active" : ""}">
          <input type="radio" name="questionType" value="multiple_choice"${type === "multiple_choice" ? " checked" : ""}>
          <span>Multiple Choice</span>
        </label>
        <label class="${type === "essay" ? "is-active" : ""}">
          <input type="radio" name="questionType" value="essay"${type === "essay" ? " checked" : ""}>
          <span>Essay</span>
        </label>
      </div>
    `;
  }

  // Pagination soal saat create bank memakai slider window:
  // maksimal 5 nomor tampil, next setelah nomor 5 menggeser window menjadi 2-6, lalu 3-7, dst.
  function questionPagerHtml(draft) {
    const total = draft.questions.length;
    draft.pagerStart = Math.min(draft.pagerStart || 0, Math.max(0, total - 5));
    const visibleCount = Math.min(total, 5);
    const visiblePages = Array.from({ length: visibleCount }, (_, index) => draft.pagerStart + index);
    const pageButtons = visiblePages.map((index) => `
      <button class="question-page-btn${draft.activeIndex === index ? " is-active" : ""}" type="button" data-action="select-question-page" data-index="${index}">
        ${index + 1}
      </button>
    `).join("");

    return `
      <div class="question-pager" aria-label="Question pagination">
        <button class="question-nav-btn" type="button" data-action="prev-question-page" aria-label="Previous question"><i data-lucide="chevron-left"></i></button>
        ${pageButtons}
        <button class="question-page-btn is-add" type="button" data-action="add-question-page" aria-label="Add question">+</button>
        <button class="question-page-btn is-remove" type="button" data-action="remove-question-page" aria-label="Delete current question">-</button>
        <button class="question-nav-btn" type="button" data-action="next-question-page" aria-label="Next question"><i data-lucide="chevron-right"></i></button>
      </div>
    `;
  }

  // Merender ulang hanya bagian Add Question saat user pindah nomor soal.
  function renderQuestionEditor() {
    const host = document.querySelector("#questionEditorHost");
    if (!host || !questionBankDraft) {
      return;
    }

    const draft = questionBankDraft;
    const question = draft.questions[draft.activeIndex];
    host.innerHTML = questionEditorHtml(draft, question);

    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  function questionEditorHtml(draft, question) {
    const answerOptions = [
      ["A", question.optionA],
      ["B", question.optionB],
      ["C", question.optionC],
      ["D", question.optionD]
    ];

    return `
      <div class="question-editor-card">
        <div class="question-editor-head">
          <h2>Add Question</h2>
          ${questionPagerHtml(draft)}
        </div>

        <div class="question-form-row is-question">
          <div class="create-form-copy">
            <h2>Question</h2>
            <p>Add text, equation symbols, and an optional image for this question.</p>
          </div>
          <div class="create-form-control">
            <div class="editor-shell">
              ${editorFieldHtml("questionText", question.questionText, "Enter description for the description")}
              ${editorToolbarHtml()}
            </div>
            ${questionImageUploadHtml(question)}
          </div>
        </div>

        <div class="question-form-row is-question-type">
          <div class="create-form-copy">
            <h2>Question Type</h2>
            <p>Choose whether this question is scored automatically or reviewed manually.</p>
          </div>
          <div class="create-form-control">
            ${questionTypeControlHtml(question)}
          </div>
        </div>

        ${question.questionType === "essay" ? `
          <div class="question-form-row is-essay-note">
            <div class="create-form-copy">
              <h2>Essay Review</h2>
              <p>Candidate answers will be reviewed and scored manually from Test Results.</p>
            </div>
            <div class="essay-note-box">
              <i data-lucide="clipboard-check"></i>
              <span>Essay question does not need answer options.</span>
            </div>
          </div>
        ` : `
        <div class="question-form-row is-answer">
          <div class="create-form-copy">
            <h2>Answer</h2>
            <p>Add a short description to help others understand this subject</p>
          </div>
          <div class="answer-options">
            ${answerOptions.map(([answer, value], index) => `
              <label class="answer-option">
                <input type="radio" name="correctOption" value="${answer}"${question.correctOption === answer ? " checked" : ""}>
                <input class="create-input" name="option${answer}" type="text" value="${escapeHtml(value)}" placeholder="Option ${index + 1}" dir="auto">
              </label>
            `).join("")}
          </div>
        </div>
        `}
      </div>
    `;
  }

  // Segmented control Randomize: nilai 1 mengacak soal saat selection test, nilai 0 menjaga urutan asli.
  function randomizeControlHtml(value) {
    const isEnabled = Number(value) === 1;
    return `
      <div class="randomize-toggle">
        <label class="${isEnabled ? "is-active" : ""}">
          <input type="radio" name="isRandomized" value="1"${isEnabled ? " checked" : ""}>
          <span>Enable</span>
        </label>
        <label class="${!isEnabled ? "is-active" : ""}">
          <input type="radio" name="isRandomized" value="0"${!isEnabled ? " checked" : ""}>
          <span>Disable</span>
        </label>
      </div>
    `;
  }

  function questionImportPreviewHtml(draft) {
    const preview = draft.importPreview;
    if (!preview) {
      return '<div class="excel-preview-empty">No template uploaded yet.</div>';
    }

    if (preview.rows.length === 0) {
      return `<div class="excel-preview-empty">No questions found in ${escapeHtml(preview.fileName)}.</div>`;
    }

    const totalErrors = preview.rows.reduce((total, row) => total + row.errors.length, 0);
    const rows = preview.rows.slice(0, 8).map((row) => `
      <tr class="${row.errors.length ? "has-error" : ""}">
        <td>${row.index}</td>
        <td>${row.question.questionType === "essay" ? "Essay" : "Multiple Choice"}</td>
        <td>${escapeHtml(excerpt(row.question.questionText, 70))}</td>
        <td>${escapeHtml(row.question.questionType === "essay" ? "-" : (row.question.correctOption || "-"))}</td>
        <td>${row.errors.length ? escapeHtml(row.errors.join("; ")) : "OK"}</td>
      </tr>
    `).join("");

    return `
      <div class="excel-preview-summary">
        <strong>${escapeHtml(preview.fileName)}</strong>
        <span>${preview.rows.length} questions detected</span>
        <span class="${totalErrors ? "is-danger" : "is-success"}">${totalErrors ? `${totalErrors} validation issues` : "Ready to import"}</span>
      </div>
      <div class="excel-preview-table-wrap">
        <table class="excel-preview-table">
          <thead>
            <tr>
              <th>No</th>
              <th>Type</th>
              <th>Question</th>
              <th>Answer</th>
              <th>Validation</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${preview.rows.length > 8 ? `<div class="excel-preview-note">Showing first 8 of ${preview.rows.length} rows.</div>` : ""}
      <button class="primary-btn import-preview-btn" type="button" data-action="import-question-preview" ${totalErrors ? "disabled" : ""}>
        <i data-lucide="file-check-2"></i>
        <span>Import Question</span>
      </button>
    `;
  }

  function questionImportHtml(draft) {
    return `
      <div class="create-form-row">
        <div class="create-form-copy">
          <div class="bulk-upload-title">
            <h2>Bulk Upload Question Bank</h2>
            <button class="bulk-guide-btn" type="button" data-action="show-import-guide" aria-label="Show template guide">
              <i data-lucide="info"></i>
            </button>
          </div>
          <p>Upload questions using the provided template, preview them, then import into this question bank.</p>
        </div>
        <div class="create-form-control">
          <div class="excel-upload-panel">
            <div class="excel-upload-actions">
              <a class="secondary-btn excel-template-link" href="${questionTemplatePath}" download="template_bulk_upload_soal.xlsx">
                <i data-lucide="download"></i>
                <span>Download Template</span>
              </a>
              <label class="primary-btn excel-upload-label">
                <input class="excel-upload-input" type="file" accept=".xlsx,.xls">
                <i data-lucide="upload"></i>
                <span>Bulk Upload</span>
              </label>
            </div>
            <div class="excel-preview" id="questionImportPreview">
              ${questionImportPreviewHtml(draft)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderQuestionImportPreview() {
    const host = document.querySelector("#questionImportPreview");
    if (!host || !questionBankDraft) {
      return;
    }

    host.innerHTML = questionImportPreviewHtml(questionBankDraft);
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  async function handleQuestionTemplateFile(file) {
    if (!questionBankDraft || !file) {
      return;
    }

    if (!window.XLSX) {
      showValidationPopup("Excel parser belum siap. Pastikan koneksi internet aktif untuk memuat library XLSX.");
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const rows = parseQuestionTemplateRows(workbook);
      questionBankDraft.importPreview = {
        fileName: file.name,
        rows
      };
      renderQuestionImportPreview();
    } catch (error) {
      questionBankDraft.importPreview = null;
      renderQuestionImportPreview();
      showValidationPopup(error.message || "Unable to read Excel template.");
    }
  }

  function importQuestionPreviewToDraft() {
    if (!questionBankDraft?.importPreview) {
      return;
    }

    syncActiveQuestionDraft();
    const previewRows = questionBankDraft.importPreview.rows;
    const hasErrors = previewRows.some((row) => row.errors.length);
    if (hasErrors) {
      showValidationPopup("Please fix validation errors in the Excel file before importing.");
      return;
    }

    const importedQuestions = previewRows.map((row) => row.question);
    const existingQuestions = questionBankDraft.questions.filter(hasQuestionContent);
    questionBankDraft.questions = existingQuestions.length ? [...existingQuestions, ...importedQuestions] : importedQuestions;
    questionBankDraft.activeIndex = Math.max(0, questionBankDraft.questions.length - importedQuestions.length);
    questionBankDraft.pagerStart = Math.max(0, questionBankDraft.activeIndex - 4);
    questionBankDraft.importPreview = null;
    renderQuestionImportPreview();
    renderQuestionEditor();
    showFlash(`${importedQuestions.length} questions imported into the question bank draft.`);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Image could not be read."));
      reader.readAsDataURL(file);
    });
  }

  async function handleQuestionImageFile(file) {
    if (!questionBankDraft || !file) {
      return;
    }

    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) {
      showValidationPopup("Please upload a PNG, JPG, GIF, or WEBP image.");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      showValidationPopup("Image size must be 2 MB or smaller.");
      return;
    }

    syncActiveQuestionDraft();
    const imageData = await fileToDataUrl(file);
    if (!isQuestionImageDataUrl(imageData)) {
      showValidationPopup("Image format is not supported.");
      return;
    }

    // Debug: gambar ditempel pada soal aktif, bukan global bank, agar tiap nomor punya attachment sendiri.
    const activeQuestion = questionBankDraft.questions[questionBankDraft.activeIndex];
    activeQuestion.imageData = imageData;
    activeQuestion.imageName = file.name;
    renderQuestionEditor();
  }

  // Halaman isi bank soal sesuai referensi HRIS Dashboard fill QB.
  function renderCreateQuestionBankPage() {
    const draft = ensureQuestionBankDraft();
    const activeQuestion = draft.questions[draft.activeIndex];

    return `
      <section class="question-bank-create-card">
        <form class="question-bank-form" data-form="question-bank-page">
          <div class="create-page-head">
            <button class="back-link" type="button" data-action="back-question-bank" aria-label="Back to question bank list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>Create Question Bank</h1>
            <div class="create-page-actions">
              <button class="draft-btn" type="submit" name="publishMode" value="0">Save as Draft</button>
              <button class="publish-btn" type="submit" name="publishMode" value="1">
                <span>Publish</span>
                <i data-lucide="plus"></i>
              </button>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Course</h2>
              <p>Choose the related course category</p>
            </div>
            <div class="create-form-control">
              <select class="create-select" name="courseId" required>
                <option value="">Select course for the question bank</option>
                ${questionBankCourseOptions(draft.courseId)}
              </select>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Passing Score</h2>
              <p>Set the minimum score required to pass</p>
            </div>
            <div class="create-form-control">
              <input class="create-input" name="passingScore" type="number" min="0" max="100" value="${escapeHtml(draft.passingScore)}" placeholder="Enter passing score for question bank">
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Randomize</h2>
              <p>Enable question randomization to display questions in a different order for each participant.</p>
            </div>
            <div class="create-form-control">
              ${randomizeControlHtml(draft.isRandomized)}
            </div>
          </div>

          ${questionImportHtml(draft)}

          <div id="questionEditorHost">
            ${questionEditorHtml(draft, activeQuestion)}
          </div>
        </form>
      </section>
    `;
  }

  // Halaman Edit Question Bank memakai editor yang sama dengan create, tetapi draft diisi dari data lama.
  // Bagian Class ditampilkan sebagai informasi turunan dari Position, tidak disimpan ke database.
  function renderEditQuestionBankPage(questionBankId) {
    const bank = findQuestionBank(questionBankId);

    if (!bank) {
      return `
        <section class="question-bank-create-card">
          <div class="create-page-head">
            <button class="back-link" type="button" data-action="back-question-bank" aria-label="Back to question bank list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>Edit Question Bank</h1>
          </div>
          <div class="empty-state">Question bank was not found.</div>
        </section>
      `;
    }

    const draft = questionBankDraft && Number(questionBankDraft.id) === Number(questionBankId)
      ? questionBankDraft
      : loadQuestionBankDraft(bank);
    const activeQuestion = draft.questions[draft.activeIndex];
    return `
      <section class="question-bank-create-card">
        <form class="question-bank-form" data-form="question-bank-page" data-mode="edit" data-id="${bank.id}">
          <div class="create-page-head">
            <button class="back-link" type="button" data-action="back-question-bank" aria-label="Back to question bank list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>Edit Question Bank</h1>
            <div class="create-page-actions">
              <button class="draft-btn" type="submit" name="publishMode" value="0">Save as Draft</button>
              <button class="publish-btn" type="submit" name="publishMode" value="1">
                <span>Save</span>
                <i data-lucide="plus"></i>
              </button>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Course</h2>
              <p>Choose the related course category</p>
            </div>
            <div class="create-form-control">
              <select class="create-select" name="courseId" required>
                <option value="">Select course for the question bank</option>
                ${questionBankCourseOptions(draft.courseId)}
              </select>
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Passing Score</h2>
              <p>Set the minimum score required to pass</p>
            </div>
            <div class="create-form-control">
              <input class="create-input" name="passingScore" type="number" min="0" max="100" value="${escapeHtml(draft.passingScore)}" placeholder="Enter passing score for question bank">
            </div>
          </div>

          <div class="create-form-row">
            <div class="create-form-copy">
              <h2>Randomize</h2>
              <p>Enable question randomization to display questions in a different order for each participant.</p>
            </div>
            <div class="create-form-control">
              ${randomizeControlHtml(draft.isRandomized)}
            </div>
          </div>

          ${questionImportHtml(draft)}

          <div id="questionEditorHost">
            ${questionEditorHtml(draft, activeQuestion)}
          </div>
        </form>
      </section>
    `;
  }

  // Halaman View Question Bank: satu halaman menampilkan maksimal 10 soal.
  // Halaman berikutnya dibuka lewat pagination control, tanpa mengubah data MySQL.
  function renderViewQuestionBankPage(questionBankId) {
    const bank = findQuestionBank(questionBankId);
    const page = Math.max(1, Number(new URLSearchParams(window.location.search).get("page") || 1));

    if (!bank) {
      return `
        <section class="view-course-card">
          <div class="view-course-head">
            <button class="back-link" type="button" data-action="back-question-bank" aria-label="Back to question bank list">
              <i data-lucide="arrow-left"></i>
            </button>
            <h1>View Question Bank</h1>
          </div>
          <div class="empty-state">Question bank was not found.</div>
        </section>
      `;
    }

    const questions = Array.isArray(bank.questions) ? bank.questions : [];
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(questions.length / perPage));
    const activePage = Math.min(page, totalPages);
    const visibleQuestions = questions.slice((activePage - 1) * perPage, activePage * perPage);

    return `
      <section class="view-course-card view-question-bank-card">
        <div class="view-course-head">
          <button class="back-link" type="button" data-action="back-question-bank" aria-label="Back to question bank list">
            <i data-lucide="arrow-left"></i>
          </button>
          <h1>View Question Bank</h1>
          <span class="view-eye" aria-hidden="true"><i data-lucide="eye"></i></span>
        </div>

        <div class="view-course-body">
          <div class="view-field">
            <span>Course</span>
            <strong>${escapeHtml(bank.courseName)}</strong>
          </div>

          <div class="view-field">
            <span>Passing Score</span>
            <strong>${escapeHtml(bank.passingScore)}</strong>
          </div>

          <div class="view-question-list">
            ${visibleQuestions.map((question, index) => viewQuestionHtml(question, (activePage - 1) * perPage + index + 1)).join("")}
          </div>

          ${viewQuestionPaginationHtml(bank.id, activePage, totalPages)}
        </div>
      </section>
    `;
  }

  // Radio dibuat disabled supaya user dapat melihat jawaban benar tanpa bisa mengubahnya.
  function viewQuestionHtml(question, number) {
    if (question.questionType === "essay") {
      return `
        <article class="view-question-item">
          <h2>Question ${number} <span class="essay-badge">Essay</span></h2>
          <p${rtlAttrs(question.questionText)}>${richTextHtml(question.questionText)}</p>
          ${questionImageHtml(question)}
        </article>
      `;
    }

    const options = [
      ["A", question.optionA],
      ["B", question.optionB],
      ["C", question.optionC],
      ["D", question.optionD]
    ];

    return `
      <article class="view-question-item">
        <h2>Question ${number}</h2>
        <p${rtlAttrs(question.questionText)}>${richTextHtml(question.questionText)}</p>
        ${questionImageHtml(question)}
        <div class="view-answer-list">
          ${options.map(([answer, value]) => `
            <label class="view-answer-option">
              <input type="radio" disabled${question.correctOption === answer ? " checked" : ""}>
              ${answerLabelHtml(answer, value)}
            </label>
          `).join("")}
        </div>
      </article>
    `;
  }

  // View Test Result: menampilkan jawaban kandidat, menandai salah merah, dan jawaban benar hijau.
  function resultQuestionHtml(question, number) {
    if (question.questionType === "essay") {
      return essayReviewHtml(question, number);
    }

    const options = [
      ["A", question.optionA],
      ["B", question.optionB],
      ["C", question.optionC],
      ["D", question.optionD]
    ];
    const candidateAnswer = question.candidateAnswer || "";
    const correctAnswer = question.correctOption || "";

    return `
      <article class="view-question-item result-question-item">
        ${questionTitleHtml(number, question.questionText)}
        ${questionImageHtml(question)}
        <div class="view-answer-list">
          ${options.map(([answer, value]) => {
            const isCandidate = candidateAnswer === answer;
            const isCorrect = correctAnswer === answer;
            const isWrongChoice = isCandidate && !isCorrect;
            const optionClass = isCorrect ? " is-correct" : isWrongChoice ? " is-wrong" : "";
            const correctLabel = isCorrect && candidateAnswer !== correctAnswer ? ' <em>(Correct Answer)</em>' : "";

            return `
              <label class="view-answer-option result-answer-option${optionClass}">
                <input type="radio" disabled${isCandidate || isCorrect ? " checked" : ""}>
                ${answerLabelHtml(answer, value)}${correctLabel}
              </label>
            `;
          }).join("")}
        </div>
      </article>
    `;
  }

  function essayReviewHtml(question, number, options = {}) {
    const editable = options.editable === true;
    return `
      <article class="view-question-item result-question-item">
        ${questionTitleHtml(number, question.questionText, ' <span class="essay-badge">Essay</span>')}
        ${questionImageHtml(question)}
        <div class="essay-answer-review">
          <span>Candidate Answer</span>
          <p${rtlAttrs(question.essayAnswer)}>${escapeHtml(question.essayAnswer || "No answer submitted.")}</p>
        </div>
        <div class="essay-review-status">
          ${editable
        ? '<span class="status-pill is-waiting">Ready for Review</span>'
        : `<span class="status-pill${question.essayReviewed ? "" : " is-waiting"}">${question.essayReviewed ? `Essay Score: ${escapeHtml(question.essayScore ?? "-")}` : "Waiting for Review"}</span>`}
        </div>
      </article>
    `;
  }

  function plainPdfText(value) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = richTextHtml(value)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<sup>(.*?)<\/sup>/gi, "^$1");
    return wrapper.textContent.replace(/\n{3,}/g, "\n\n").trim();
  }

  function decodeUtf8ByteString(value) {
    const bytes = [];
    Array.from(String(value || "")).forEach((char) => {
      const code = char.charCodeAt(0);
      if (code <= 255) {
        bytes.push(code);
      }
    });

    if (!bytes.length) {
      return "";
    }

    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
    } catch (error) {
      return "";
    }
  }

  function normalizePdfUnicodeText(value) {
    const text = String(value || "");
    if (hasArabicText(text)) {
      return text;
    }

    // cPanel/MySQL charset mismatch can turn Arabic into mojibake; repair that before canvas/PDF rendering.
    const repaired = decodeUtf8ByteString(text);
    return hasArabicText(repaired) ? repaired : text;
  }

  function pdfFileName(value) {
    return String(value || "review-essay")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "review-essay";
  }

  let pdfPoppinsFontLoaded = false;

  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return window.btoa(binary);
  }

  async function loadPdfPoppinsFont(doc) {
    if (pdfPoppinsFontLoaded) {
      return;
    }

    const fonts = [
      ["fonts/Poppins-Regular.ttf", "Poppins-Regular.ttf", "normal"],
      ["fonts/Poppins-Bold.ttf", "Poppins-Bold.ttf", "bold"],
      ["fonts/Poppins-BoldItalic.ttf", "Poppins-BoldItalic.ttf", "bolditalic"]
    ];

    // Debug PDF: jsPDF tidak membaca CSS Google Font, jadi TTF Poppins didaftarkan langsung ke virtual file system.
    for (const [path, fileName, style] of fonts) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Unable to load ${fileName}`);
      }
      const fontBase64 = arrayBufferToBase64(await response.arrayBuffer());
      doc.addFileToVFS(fileName, fontBase64);
      doc.addFont(fileName, "Poppins", style);
    }

    pdfPoppinsFontLoaded = true;
  }

  function ensurePdfSpace(doc, y, neededHeight, margin, pageHeight) {
    if (y + neededHeight <= pageHeight - margin) {
      return y;
    }

    doc.addPage();
    return margin;
  }

  function addPdfWrappedText(doc, text, x, y, maxWidth, lineHeight) {
    const lines = doc.splitTextToSize(String(text || ""), maxWidth);
    doc.text(lines, x, y);
    return y + (lines.length * lineHeight);
  }

  function pdfCanvasTextLines(context, text, maxWidthPx) {
    const paragraphs = String(text || "").split(/\n/);
    const lines = [];

    paragraphs.forEach((paragraph) => {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      if (!words.length) {
        lines.push("");
        return;
      }

      let line = "";
      words.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word;
        if (context.measureText(candidate).width <= maxWidthPx) {
          line = candidate;
          return;
        }

      if (line) {
        lines.push(line);
      }
      if (context.measureText(word).width <= maxWidthPx) {
        line = word;
        return;
      }

      let chunk = "";
      Array.from(word).forEach((char) => {
        const candidateChunk = chunk + char;
        if (context.measureText(candidateChunk).width <= maxWidthPx) {
          chunk = candidateChunk;
          return;
        }

        if (chunk) {
          lines.push(chunk);
        }
        chunk = char;
      });
      line = chunk;
    });

      if (line) {
        lines.push(line);
      }
    });

    return lines.length ? lines : [""];
  }

  function pdfCanvasTextBlock(text, maxWidthMm, fontSize = 10, fontWeight = "normal") {
    const scale = 3;
    const pxPerMm = (96 / 25.4) * scale;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const widthPx = Math.max(1, Math.round(maxWidthMm * pxPerMm));
    const fontPx = Math.max(10, Math.round(fontSize * (96 / 72) * scale));
    const lineHeightPx = Math.round(fontPx * 1.55);
    const paddingPx = Math.round(1.5 * pxPerMm);
    const direction = hasArabicText(text) ? "rtl" : "ltr";

    context.font = `${fontWeight} ${fontPx}px Tahoma, Arial, sans-serif`;
    const lines = pdfCanvasTextLines(context, text, widthPx - (paddingPx * 2));
    const heightPx = Math.max(lineHeightPx + (paddingPx * 2), (lines.length * lineHeightPx) + (paddingPx * 2));

    canvas.width = widthPx;
    canvas.height = heightPx;
    context.clearRect(0, 0, widthPx, heightPx);
    context.fillStyle = "#000000";
    context.font = `${fontWeight} ${fontPx}px Tahoma, Arial, sans-serif`;
    context.direction = direction;
    context.textAlign = direction === "rtl" ? "right" : "left";
    context.textBaseline = "top";

    const textX = direction === "rtl" ? widthPx - paddingPx : paddingPx;
    lines.forEach((line, index) => {
      context.fillText(line, textX, paddingPx + (index * lineHeightPx));
    });

    return {
      imageData: canvas.toDataURL("image/png"),
      width: maxWidthMm,
      height: heightPx / pxPerMm
    };
  }

  function pdfTextBlock(doc, text, maxWidth, options = {}) {
    const safeText = normalizePdfUnicodeText(text);
    const fontSize = options.fontSize || 10;
    const lineHeight = options.lineHeight || 5;
    const fontStyle = options.fontStyle || "normal";
    const fontWeight = fontStyle.includes("bold") ? "700" : "400";

    if (hasArabicText(safeText)) {
      // jsPDF text rendering does not shape Arabic reliably, so Arabic/RTL blocks are rendered by the browser canvas first.
      const block = pdfCanvasTextBlock(safeText, maxWidth, fontSize, fontWeight);
      return {
        height: block.height,
        draw(x, y) {
          doc.addImage(block.imageData, "PNG", x, y, block.width, block.height);
          return y + block.height;
        }
      };
    }

    doc.setFont("Poppins", fontStyle);
    doc.setFontSize(fontSize);
    const lines = doc.splitTextToSize(safeText, maxWidth);
    return {
      height: lines.length * lineHeight,
      draw(x, y) {
        doc.setFont("Poppins", fontStyle);
        doc.setFontSize(fontSize);
        doc.text(lines, x, y);
        return y + (lines.length * lineHeight);
      }
    };
  }

  function drawPdfHeader(doc, result, margin, pageWidth) {
    const contentWidth = pageWidth - (margin * 2);
    let y = margin + 2;
    const scoreBoxWidth = 32;
    const scoreBoxHeight = 22;
    const scoreBoxX = pageWidth - margin - scoreBoxWidth;
    const scoreBoxY = margin - 2;

    doc.setTextColor(0, 0, 0);
    doc.setFont("Poppins", "bold");
    doc.setFontSize(18);
    doc.text("ESSAY TEST RESULT", pageWidth / 2, y, { align: "center" });

    // Kotak Final Score sengaja kosong untuk diisi manual penerima data essay.
    doc.setDrawColor(128, 128, 128);
    doc.rect(scoreBoxX, scoreBoxY, scoreBoxWidth, scoreBoxHeight);
    doc.line(scoreBoxX, scoreBoxY + 8, scoreBoxX + scoreBoxWidth, scoreBoxY + 8);
    doc.setFont("Poppins", "bold");
    doc.setFontSize(8);
    doc.text("Final Score", scoreBoxX + (scoreBoxWidth / 2), scoreBoxY + 5.4, { align: "center" });

    y += 10;

    doc.setFont("Poppins", "bolditalic");
    doc.setFontSize(12);
    doc.text("Teacher Recruitment System", margin, y);
    y += 8;

    doc.setDrawColor(211, 211, 211);
    doc.line(margin, y, pageWidth - margin, y);
    y += 12;

    const rows = [
      ["Full Name", result.fullName || "-"],
      ["Position", result.education || "-"],
      ["Region", result.region || "-"],
      ["Submission Date", resultDateLabel(result.submittedAt)]
    ];
    const labelWidth = 50;
    const rowHeight = 11;
    const tableX = margin + 6;
    const tableWidth = contentWidth - 12;

    rows.forEach(([label, value], index) => {
      const rowY = y + (index * rowHeight);
      doc.setFillColor(211, 211, 211);
      doc.rect(tableX, rowY, labelWidth, rowHeight, "F");
      doc.setDrawColor(128, 128, 128);
      doc.rect(tableX, rowY, tableWidth, rowHeight);
      doc.line(tableX + labelWidth, rowY, tableX + labelWidth, rowY + rowHeight);
      doc.setFont("Poppins", "normal");
      doc.setFontSize(10);
      doc.setTextColor(0, 0, 0);
      doc.text(label, tableX + 3, rowY + 7);
      doc.text(String(value), tableX + labelWidth + 3, rowY + 7);
    });

    return y + (rows.length * rowHeight) + 16;
  }

  function drawPdfAssessmentTable(doc, x, y, width) {
    const labelWidth = 50;
    const scoreHeight = 11;
    const notesHeight = 28;
    const rows = [
      ["Score", scoreHeight],
      ["Reviewer Notes", notesHeight]
    ];
    let cursorY = y;

    rows.forEach(([label, rowHeight]) => {
      doc.setFillColor(211, 211, 211);
      doc.rect(x, cursorY, labelWidth, rowHeight, "F");
      doc.setDrawColor(128, 128, 128);
      doc.rect(x, cursorY, width, rowHeight);
      doc.line(x + labelWidth, cursorY, x + labelWidth, cursorY + rowHeight);
      doc.setTextColor(0, 0, 0);
      doc.setFont("Poppins", "normal");
      doc.setFontSize(10);
      doc.text(label, x + 3, cursorY + 7);
      // Kolom kanan sengaja kosong supaya penerima data essay bisa mengisi nilai dan catatan manual.
      cursorY += rowHeight;
    });

    return cursorY;
  }

  function pdfDownloadDateLabel() {
    return new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(new Date());
  }

  function drawPdfFinalAssessment(doc, y, margin, pageWidth, pageHeight) {
    const neededHeight = 78;
    y = ensurePdfSpace(doc, y, neededHeight, margin, pageHeight);

    doc.setDrawColor(211, 211, 211);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;

    doc.setTextColor(0, 0, 0);
    doc.setFont("Poppins", "normal");
    doc.setFontSize(11);
    doc.text(`Jakarta, ${pdfDownloadDateLabel()}`, margin, y);
    y += 22;

    doc.text("Reviewed By,", margin, y);
    y += 30;

    // Nama reviewer sengaja dikosongkan agar penerima data essay bisa mengisi manual.
    doc.text("", margin, y);
    y += 24;

    doc.text("Signature:", margin, y);
    y += 22;

    doc.line(margin, y, margin + 76, y);
    return y + 8;
  }

  async function downloadReviewEssayPdf(resultId) {
    const result = findApplicationResult(resultId);
    if (!result) {
      showValidationPopup("Test result was not found.");
      return;
    }

    if (!window.jspdf?.jsPDF) {
      showValidationPopup("PDF library is not ready. Please check your internet connection and refresh the dashboard.");
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    try {
      await loadPdfPoppinsFont(doc);
    } catch (error) {
      showValidationPopup("Poppins font could not be loaded for the PDF. Please refresh the dashboard and try again.");
      return;
    }

    const margin = 16;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const contentWidth = pageWidth - (margin * 2);
    const tableX = margin + 6;
    const tableWidth = contentWidth - 12;
    let y = drawPdfHeader(doc, result, margin, pageWidth);

    // Debug PDF: file mengikuti template_essay_result.pdf dan diunduh langsung via jsPDF.save().
    const essayQuestions = questionsForResult(result).filter((question) => question.questionType === "essay");
    essayQuestions.forEach((question, index) => {
      const questionTitle = `Essay Question ${index + 1}`;
      const questionText = plainPdfText(question.questionText);
      const answerText = question.essayAnswer || "No answer submitted.";
      const questionBlock = pdfTextBlock(doc, questionText, contentWidth, { fontSize: 10, lineHeight: 5 });
      const answerBlock = pdfTextBlock(doc, answerText, tableWidth - 6, { fontSize: 10, lineHeight: 5 });
      const answerHeight = Math.max(14, answerBlock.height + 8);
      const blockHeight = 22 + questionBlock.height + answerHeight + 60;

      y = ensurePdfSpace(doc, y, blockHeight, margin, pageHeight);
      doc.setDrawColor(211, 211, 211);
      doc.line(margin, y, pageWidth - margin, y);
      y += 13;

      doc.setTextColor(0, 0, 0);
      doc.setFont("Poppins", "bold");
      doc.setFontSize(14);
      doc.text(questionTitle, margin, y);
      y += 11;

      doc.setFont("Poppins", "normal");
      doc.setFontSize(10);
      y = questionBlock.draw(margin, y) + 4;

      if (isQuestionImageDataUrl(question.imageData)) {
        try {
          const imageProps = doc.getImageProperties(question.imageData);
          const imageWidth = Math.min(contentWidth, 96);
          const imageHeight = imageWidth * (imageProps.height / imageProps.width);
          y = ensurePdfSpace(doc, y, imageHeight + 8, margin, pageHeight);
          doc.addImage(question.imageData, imageProps.fileType, margin, y, imageWidth, imageHeight);
          y += imageHeight + 6;
        } catch (error) {
          y = addPdfWrappedText(doc, "[Question image could not be embedded]", margin, y, contentWidth, 5) + 3;
        }
      }

      doc.setFont("Poppins", "bolditalic");
      doc.setFontSize(12);
      doc.text("Candidate Answer", margin, y);
      y += 8;

      doc.setFillColor(245, 245, 245);
      doc.setDrawColor(128, 128, 128);
      doc.rect(tableX, y, tableWidth, answerHeight, "FD");
      doc.setTextColor(0, 0, 0);
      doc.setFont("Poppins", "normal");
      doc.setFontSize(10);
      answerBlock.draw(tableX + 3, y + 4);
      y += answerHeight + 12;

      doc.setFont("Poppins", "bolditalic");
      doc.setFontSize(12);
      doc.text("Reviewer Assessment", margin, y);
      y += 8;

      y = drawPdfAssessmentTable(doc, tableX, y, tableWidth) + 10;
    });

    y = drawPdfFinalAssessment(doc, y, margin, pageWidth, pageHeight);

    doc.save(`${pdfFileName(result.fullName)}-review-essay.pdf`);
  }

  function viewQuestionPaginationHtml(questionBankId, activePage, totalPages) {
    if (totalPages <= 1) {
      return "";
    }

    const pages = Array.from({ length: totalPages }, (_, index) => index + 1);
    return `
      <div class="view-question-pagination">
        ${pages.map((page) => `
          <button class="question-page-btn${page === activePage ? " is-active" : ""}" type="button" data-action="view-question-bank-page" data-id="${questionBankId}" data-page="${page}">
            ${page}
          </button>
        `).join("")}
      </div>
    `;
  }

  // Membuka modal create/view/edit question.
  // Escape nilai CSV agar koma/kutip di data tidak merusak format export.
  function csvValue(value) {
    return `"${String(value || "").replace(/"/g, '""')}"`;
  }

  // Export mengambil semua result sesuai filter secara bertahap; load menu tetap ringan karena export hanya jalan saat diminta.
  async function exportResults() {
    const pageSize = 100;
    let page = 1;
    let total = 0;
    let allApplications = [];

    do {
      const payload = await window.RecruitmentStore.getResults({
        page,
        pageSize,
        course: resultFilters.course,
        education: resultFilters.education,
        sortKey: resultSort.key,
        sortDirection: resultSort.direction
      });
      total = payload.total;
      allApplications = allApplications.concat(payload.applications);
      page++;
    } while (allApplications.length < total && page < 10000);

    const rows = allApplications.map((application) => [
      application.id,
      application.fullName,
      application.email,
      application.phone,
      application.education,
      application.course,
      finalScoreLabel(application),
      multipleChoiceScore(application),
      resultHasEssay(application) ? essayScore(application) : "-",
      hasPassedResult(application) ? "Passed" : "Not Passed",
      application.submittedAt
    ]);
    const csv = [
      ["ID", "Full Name", "Email", "Phone", "Education", "Course", "Final Score", "Multiple Choice Score", "Essay Score", "Status", "Submitted At"],
      ...rows
    ].map((row) => row.map(csvValue).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "recruitment-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  // Event delegation: satu listener menangani klik semua tombol/nav berbasis data-action.
  document.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-section], [data-action]");
    if (!trigger) {
      return;
    }

    const { section, action, id } = trigger.dataset;

    if (section) {
      event.preventDefault();
      await navigate(section);
      return;
    }

    try {
      if (action) {
        event.preventDefault();
      }

      if (action === "toggle-profile-menu") {
        const willOpen = !profileMenu.classList.contains("is-open");
        profileMenu.classList.toggle("is-open", willOpen);
        profileMenuToggle.setAttribute("aria-expanded", String(willOpen));
      }
      if (action === "toggle-position-dropdown") {
        const root = trigger.closest("[data-position-multiselect]");
        if (root) {
          const willOpen = !root.classList.contains("is-open");
          closePositionDropdowns(root);
          root.classList.toggle("is-open", willOpen);
          trigger.setAttribute("aria-expanded", String(willOpen));
        }
      }
      if (action === "show-course-table") await navigate("course");
      if (action === "show-position-table") await navigate("course", "positions");
      if (action === "create-course") await navigate("course", "create");
      if (action === "back-course") await navigate("course");
      if (action === "apply-course-filter") {
        const filterRoot = trigger.closest("#courseFilter");
        courseFilterDrafts = {
          position: filterRoot?.querySelector('[name="position"]')?.value || "",
          status: filterRoot?.querySelector('[name="status"]')?.value || ""
        };
        courseFilters = { ...courseFilterDrafts };
        tablePagination.course.page = 1;
        refreshTableSection("course");
      }
      if (action === "apply-position-filter") {
        const filterRoot = trigger.closest("#positionFilter");
        positionFilterDrafts = {
          name: filterRoot?.querySelector('[name="name"]')?.value || ""
        };
        positionFilters = { ...positionFilterDrafts };
        tablePagination.position.page = 1;
        refreshTableSection("position");
      }
      if (action === "sort-courses") {
        const sortKey = trigger.dataset.sortKey || "name";
        if (courseSort.key === sortKey) {
          courseSort.direction = courseSort.direction === "asc" ? "desc" : "asc";
        } else {
          courseSort.key = sortKey;
          courseSort.direction = "asc";
        }
        tablePagination.course.page = 1;
        refreshTableSection("course");
      }
      if (action === "sort-positions") {
        const sortKey = trigger.dataset.sortKey || "name";
        if (positionSort.key === sortKey) {
          positionSort.direction = positionSort.direction === "asc" ? "desc" : "asc";
        } else {
          positionSort.key = sortKey;
          positionSort.direction = "asc";
        }
        tablePagination.position.page = 1;
        refreshTableSection("position");
      }
      if (action === "create-position") await navigate("course", "position-create");
      if (action === "back-position") await navigate("course", "positions");
      if (action === "view-position") await navigate("course", "position-view", id);
      if (action === "delete-position") {
        const confirmed = await showConfirmDialog({
          ...confirmOptions("delete"),
          title: "Delete position?",
          message: "This position will be removed only if it is not used by course or test data.",
          confirmText: "Delete"
        });
        if (!confirmed) return;

        await window.RecruitmentStore.deleteEducationLevel(id);
        showFlash("Position has been deleted.");
        await navigate("course", "positions");
      }
      if (action === "view-course") await navigate("course", "view", id);
      if (action === "edit-course") await navigate("course", "edit", id);
      if (action === "activate-course" || action === "inactivate-course") {
        const isPublished = action === "activate-course" ? 1 : 0;
        const confirmed = await showConfirmDialog(confirmOptions(isPublished === 1 ? "active" : "inactive"));
        if (!confirmed) return;

        await window.RecruitmentStore.setCourseStatus(id, isPublished);
        showFlash(isPublished === 1 ? "Course has been activated." : "Course has been inactivated.");
        await render();
      }
      if (action === "delete-course") {
        const confirmed = await showConfirmDialog(confirmOptions("delete"));
        if (!confirmed) return;

        await window.RecruitmentStore.deleteCourse(id);
        showFlash("Course has been deleted.");
        await render();
      }
      if (action === "create-question") {
        questionBankDraft = null;
        await navigate("questions", "create");
      }
      if (action === "import-question-preview") {
        importQuestionPreviewToDraft();
      }
      if (action === "show-import-guide") {
        showImportGuidePopup();
      }
      if (action === "back-question-bank") await navigate("questions");
      if (action === "select-question-page") {
        syncActiveQuestionDraft();
        questionBankDraft.activeIndex = Number(trigger.dataset.index);
        if (questionBankDraft.activeIndex < questionBankDraft.pagerStart) {
          questionBankDraft.pagerStart = questionBankDraft.activeIndex;
        }
        if (questionBankDraft.activeIndex > questionBankDraft.pagerStart + 4) {
          questionBankDraft.pagerStart = questionBankDraft.activeIndex - 4;
        }
        renderQuestionEditor();
      }
      if (action === "prev-question-page") {
        syncActiveQuestionDraft();
        questionBankDraft.activeIndex = Math.max(0, questionBankDraft.activeIndex - 1);
        if (questionBankDraft.activeIndex < questionBankDraft.pagerStart) {
          questionBankDraft.pagerStart = questionBankDraft.activeIndex;
        }
        renderQuestionEditor();
      }
      if (action === "next-question-page") {
        syncActiveQuestionDraft();
        questionBankDraft.activeIndex = Math.min(questionBankDraft.questions.length - 1, questionBankDraft.activeIndex + 1);
        if (questionBankDraft.activeIndex > questionBankDraft.pagerStart + 4) {
          questionBankDraft.pagerStart = questionBankDraft.activeIndex - 4;
        }
        renderQuestionEditor();
      }
      if (action === "add-question-page") {
        syncActiveQuestionDraft();
        // Debug: jumlah soal tidak lagi dibatasi; admin bisa menambah sesuai kebutuhan bank soal.
        questionBankDraft.questions.push(createEmptyQuestionDraft());
        questionBankDraft.activeIndex = questionBankDraft.questions.length - 1;
        questionBankDraft.pagerStart = Math.max(0, questionBankDraft.questions.length - 5);
        renderQuestionEditor();
      }
      if (action === "remove-question-page") {
        syncActiveQuestionDraft();
        if (questionBankDraft.questions.length > 1) {
          questionBankDraft.questions.splice(questionBankDraft.activeIndex, 1);
          questionBankDraft.activeIndex = Math.min(questionBankDraft.activeIndex, questionBankDraft.questions.length - 1);
          questionBankDraft.pagerStart = Math.min(questionBankDraft.pagerStart, Math.max(0, questionBankDraft.questions.length - 5));
          renderQuestionEditor();
        }
      }
      if (action === "remove-question-image") {
        syncActiveQuestionDraft();
        const activeQuestion = questionBankDraft.questions[questionBankDraft.activeIndex];
        activeQuestion.imageData = "";
        activeQuestion.imageName = "";
        renderQuestionEditor();
      }
      if (action === "view-question-bank") await navigate("questions", "view", id);
      if (action === "edit-question-bank") {
        questionBankDraft = null;
        await navigate("questions", "edit", id);
      }
      if (action === "publish-question-bank" || action === "unpublish-question-bank") {
        const isPublished = action === "publish-question-bank" ? 1 : 0;
        const confirmed = await showConfirmDialog(confirmOptions(isPublished === 1 ? "active" : "inactive"));
        if (!confirmed) return;

        await window.RecruitmentStore.setQuestionBankStatus(id, isPublished);
        showFlash(isPublished === 1 ? "Question bank has been published." : "Question bank has been unpublished.");
        await render();
      }
      if (action === "view-question-bank-page") {
        const page = Number(trigger.dataset.page || 1);
        window.history.pushState({}, "", `admin_dashboard.html?section=questions&action=view&id=${encodeURIComponent(id)}&page=${encodeURIComponent(page)}`);
        await render();
      }
      if (action === "delete-question-bank") {
        const confirmed = await showConfirmDialog(confirmOptions("delete"));
        if (!confirmed) return;

        await window.RecruitmentStore.deleteQuestionBank(id);
        showFlash("Question bank has been deleted.");
        await render();
      }
      if (action === "view-test-result") await navigate("results", "view", id);
      if (action === "view-recapitulation") {
        await navigateRecapitulation(trigger.dataset.recapId || "");
      }
      if (action === "review-essay-result") {
        const result = findApplicationResult(id);
        if (!resultHasEssay(result)) {
          showValidationPopup("This result does not have essay answers to review.");
          return;
        }

        essayReviewDraft = null;
        await navigate("results", "review", id);
      }
      if (action === "give-essay-score") {
        await loadResultDetail(id);
        const result = findApplicationResult(id);
        if (!result) {
          showFlash("Test result was not found.", "danger");
          return;
        }

        const weights = await showScoreWeightPopup(result);
        if (!weights) return;
        if (!Number.isFinite(weights.essayScore) || weights.essayScore < 0 || weights.essayScore > 100) {
          showValidationPopup("Essay score must be between 0 and 100.");
          return;
        }
        if (!Number.isFinite(weights.multipleChoiceWeight) || !Number.isFinite(weights.essayWeight) || weights.multipleChoiceWeight + weights.essayWeight !== 100) {
          showValidationPopup("Total weight must be 100%.");
          return;
        }

        await window.RecruitmentStore.updateWeightedScore(id, weights);
        showFlash("Weighted score has been saved.");
        await render();
      }
      if (action === "set-essay-review") {
        if (!essayReviewDraft) return;
        const reviewIndex = Number(trigger.closest("[data-review-index]")?.dataset.reviewIndex || 0);
        essayReviewDraft.reviews[reviewIndex] = trigger.dataset.value === "true";
        await render();
      }
      if (action === "essay-review-page") {
        if (!essayReviewDraft) return;
        essayReviewDraft.page = Number(trigger.dataset.page || 1);
        await render();
      }
      if (action === "essay-review-prev") {
        if (!essayReviewDraft) return;
        essayReviewDraft.page = Math.max(1, essayReviewDraft.page - 1);
        await render();
      }
      if (action === "essay-review-next") {
        if (!essayReviewDraft) return;
        essayReviewDraft.page += 1;
        await render();
      }
      if (action === "download-review-essay-pdf") {
        await loadResultDetail(id);
        await downloadReviewEssayPdf(id);
      }
      if (action === "back-results") await navigate("results");
      if (action === "delete-application") {
        const confirmed = await showConfirmDialog(confirmOptions("delete"));
        if (!confirmed) return;

        await window.RecruitmentStore.deleteApplication(id);
        showFlash("Application result has been deleted.");
        await render();
      }
      if (action === "send-result-email") {
        const result = findApplicationResult(id);
        if (!result || !hasPassedResult(result)) {
          showFlash("Email can only be sent to candidates who passed the selection test.", "danger");
          return;
        }

        const confirmed = await showConfirmDialog({
          ...confirmOptions("submit"),
          title: "Send result email?",
          message: `Email kelulusan akan dikirim ke ${result.email}`,
          confirmText: "Send"
        });
        if (!confirmed) return;

        await window.RecruitmentStore.sendResultEmail(id);
        showFlash("Selection test result email has been sent.");
      }
      if (action === "send-recap-email") {
        const email = trigger.dataset.email || "candidate";
        const confirmed = await showConfirmDialog({
          ...confirmOptions("submit"),
          title: "Send result email?",
          message: `Email kelulusan akan dikirim ke ${email}`,
          confirmText: "Send"
        });
        if (!confirmed) return;

        await window.RecruitmentStore.sendRecapEmail(id);
        showFlash("Recapitulation result email has been sent.");
      }
      if (action === "generate-exam-token") {
        const confirmed = await showConfirmDialog({
          ...confirmOptions("submit"),
          title: "Generate new token?",
          message: "Only your previous active token will be replaced. Other Jakarta admin tokens stay active.",
          confirmText: "Generate"
        });
        if (!confirmed) return;

        const result = await window.RecruitmentStore.generateExamToken();
        showSuccessPopup(`Active token: ${result.token.token}`);
        showFlash("Exam token has been generated.");
        await render();
      }
      if (action === "apply-result-filter") {
        const filterRoot = trigger.closest("#resultFilter");
        resultFilterDrafts = {
          course: filterRoot.querySelector('[name="course"]').value,
          education: filterRoot.querySelector('[name="education"]').value
        };
        resultFilters = { ...resultFilterDrafts };
        tablePagination.results.page = 1;
        await render();
      }
      if (action === "set-result-view") {
        resultViewMode = trigger.dataset.viewMode === "recap" ? "recap" : "results";
        tablePagination.results.page = 1;
        resultSort = resultViewMode === "recap"
          ? { key: "name", direction: "asc" }
          : { key: "date", direction: "desc" };
        await render();
      }
      if (action === "sort-results") {
        const sortKey = trigger.dataset.sortKey;
        if (resultSort.key === sortKey) {
          resultSort.direction = resultSort.direction === "asc" ? "desc" : "asc";
        } else {
          resultSort.key = sortKey;
          resultSort.direction = "asc";
        }
        tablePagination.results.page = 1;
        await render();
      }
      if (action === "change-table-page") {
        const sectionName = trigger.dataset.sectionName;
        if (tablePagination[sectionName]) {
          tablePagination[sectionName].page = Number(trigger.dataset.page || 1);
          if (sectionName === "results") {
            await render();
          } else {
            refreshTableSection(sectionName);
          }
        }
      }
      if (action === "export-results") await exportResults();
      if (action === "reset-data") {
        const confirmed = await showConfirmDialog({
          ...confirmOptions("delete"),
          title: "Reset all data?",
          message: "All courses, questions, and applications will be permanently deleted",
          confirmText: "Reset"
        });
        if (!confirmed) return;

        await window.RecruitmentStore.resetDemoData();
        showFlash("Data has been reset.");
        await render();
      }
      if (action === "logout") {
        window.sessionStorage.removeItem(authKey);
        window.sessionStorage.removeItem(adminRegionKey);
        window.sessionStorage.removeItem(adminNameKey);
        window.sessionStorage.removeItem(adminUsernameKey);
        window.location.href = "admin_login.html";
      }
      if (action === "close-modal") closeModal();
    } catch (error) {
      showFlash(error.message || "Action failed.", "danger");
    }
  });

  // Klik di luar dropdown profile akan menutup menu.
  document.addEventListener("mousedown", (event) => {
    const editorTool = event.target.closest('[data-action="format-editor-text"]');
    if (editorTool) {
      event.preventDefault();
      applyEditorFormat(editorTool);
    }

    const equationTool = event.target.closest('[data-action="insert-equation-symbol"]');
    if (equationTool) {
      event.preventDefault();
      insertEquationSymbol(equationTool);
    }
  });

  // Klik di luar dropdown profile akan menutup menu.
  document.addEventListener("click", (event) => {
    if (!profileMenu || !profileMenuToggle) {
      return;
    }

    if (!event.target.closest("[data-position-multiselect]")) {
      closePositionDropdowns();
    }

    const clickedInsideProfile = event.target.closest("#profileMenuRoot");
    if (!clickedInsideProfile) {
      profileMenu.classList.remove("is-open");
      profileMenuToggle.setAttribute("aria-expanded", "false");
    }
  });

  // Klik area gelap di luar form akan menutup modal.
  modalLayer.addEventListener("click", (event) => {
    if (event.target === modalLayer) {
      closeModal();
    }
  });

  // Submit modal course/question dikirim ke API sesuai data-form dan mode create/edit.
  document.addEventListener("input", (event) => {
    const editorInput = event.target.closest("[data-editor-input]");
    if (editorInput) {
      syncEditorValue(editorInput);
    }
  });

  document.addEventListener("keydown", (event) => {
    const editorInput = event.target.closest("[data-editor-input]");
    if (!editorInput || !editorInput.closest('[data-form="question-bank-page"]') || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    event.preventDefault();
    insertEditorLineBreak(editorInput);
  });

  // Submit modal course/question dikirim ke API sesuai data-form dan mode create/edit.
  document.addEventListener("change", async (event) => {
    const pageSizeSelect = event.target.closest('[data-action="change-page-size"]');
    if (pageSizeSelect) {
      const sectionName = pageSizeSelect.dataset.sectionName;
      if (tablePagination[sectionName]) {
        tablePagination[sectionName].pageSize = Number(pageSizeSelect.value);
        tablePagination[sectionName].page = 1;
        if (sectionName === "results") {
          await render();
        } else {
          refreshTableSection(sectionName);
        }
      }
      return;
    }

    const resultFilter = event.target.closest("#resultFilter");
    if (resultFilter && event.target.matches("select")) {
      resultFilterDrafts = {
        course: resultFilter.querySelector('[name="course"]').value,
        education: resultFilter.querySelector('[name="education"]').value
      };
      return;
    }

    const courseFilter = event.target.closest("#courseFilter");
    if (courseFilter && event.target.matches("select")) {
      courseFilterDrafts = {
        position: courseFilter.querySelector('[name="position"]').value,
        status: courseFilter.querySelector('[name="status"]').value
      };
      return;
    }

    const positionFilter = event.target.closest("#positionFilter");
    if (positionFilter && event.target.matches("select")) {
      positionFilterDrafts = {
        name: positionFilter.querySelector('[name="name"]').value
      };
      return;
    }

    const positionDropdown = event.target.closest("[data-position-multiselect]");
    if (positionDropdown && event.target.matches('input[name="educationLevels"]')) {
      updatePositionDropdownLabel(positionDropdown);
      return;
    }

    if (event.target.matches(".excel-upload-input")) {
      handleQuestionTemplateFile(event.target.files?.[0]);
      event.target.value = "";
      return;
    }

    if (event.target.matches("[data-question-image-input]")) {
      handleQuestionImageFile(event.target.files?.[0]).catch((error) => {
        showValidationPopup(error.message || "Image could not be attached.");
      });
      event.target.value = "";
      return;
    }

    const essayPageSize = event.target.closest('[data-action="essay-review-page-size"]');
    if (essayPageSize) {
      // Debug: dropdown jumlah item review essay harus diproses sebelum guard form question bank.
      if (essayReviewDraft) {
        essayReviewDraft.pageSize = Number(essayPageSize.value || 5);
        essayReviewDraft.page = 1;
        render();
      }
      return;
    }

    const questionBankForm = event.target.closest('[data-form="question-bank-page"]');
    if (!questionBankForm) {
      return;
    }

    // Segmented control Randomize memperbarui highlight Enable/Disable di tempat.
    if (event.target.name === "isRandomized") {
      questionBankForm.querySelectorAll(".randomize-toggle label").forEach((label) => {
        const input = label.querySelector("input");
        label.classList.toggle("is-active", input.checked);
      });
    }

    if (event.target.name === "questionType") {
      syncActiveQuestionDraft();
      renderQuestionEditor();
    }
  });

  // Submit modal course/question dikirim ke API sesuai data-form dan mode create/edit.
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-form]");
    if (!form) {
      return;
    }

    event.preventDefault();

    syncAllEditors(form);
    const data = Object.fromEntries(new FormData(form).entries());
    const mode = form.dataset.mode;
    const id = form.dataset.id;

    try {
      if (form.dataset.form === "position-page") {
        const confirmed = await showConfirmDialog({
          ...confirmOptions("submit"),
          title: "Add position?",
          message: "Position will be available for courses in this admin region.",
          confirmText: "Save"
        });
        if (!confirmed) return;

        const result = await window.RecruitmentStore.addEducationLevel(data);
        showSuccessPopup("Position berhasil dibuat");
        await navigate("course", "position-view", result.educationLevel.id);
        return;
      }

      // Form halaman Create/Edit Course memakai tombol Save/Save as Draft untuk menentukan status course.
      if (form.dataset.form === "course-page") {
        const submitter = event.submitter;
        // Checkbox Position memakai nama yang sama, jadi FormData.entries() hanya mengambil salah satu.
        // Array eksplisit ini yang dikirim ke backend untuk disimpan sebagai JSON.
        data.educationLevels = [...form.querySelectorAll('input[name="educationLevels"]:checked')]
          .map((input) => input.value);
        data.isPublished = submitter ? submitter.value : "1";
        const isEditMode = form.dataset.mode === "edit";
        const confirmed = await showConfirmDialog(confirmOptions(isEditMode ? "edit" : "submit"));
        if (!confirmed) return;

        const result = isEditMode
          ? await window.RecruitmentStore.updateCourse(form.dataset.id, data)
          : await window.RecruitmentStore.addCourse(data);
        const courseId = isEditMode ? form.dataset.id : result.course.id;

        // Save/Publish membuka halaman View Course dan menampilkan popup sukses.
        if (data.isPublished === "1") {
          showSuccessPopup(isEditMode ? "Course berhasil diperbarui" : "Course berhasil dibuat");
          await navigate("course", "view", courseId);
          return;
        }

        showFlash(isEditMode ? "Course changes have been saved as draft." : "Course has been saved as draft.");
        await navigate("course");
        return;
      }

      // Publish/Draft halaman Question Bank menyimpan semua soal draft ke MySQL.
      if (form.dataset.form === "question-bank-page") {
        const submitter = event.submitter;
        syncActiveQuestionDraft();
        const isEditMode = form.dataset.mode === "edit";
        const confirmed = await showConfirmDialog(confirmOptions(isEditMode ? "edit" : "submit"));
        if (!confirmed) return;

        const payload = {
          courseId: questionBankDraft.courseId,
          passingScore: questionBankDraft.passingScore,
          isPublished: submitter ? submitter.value : "1",
          isRandomized: questionBankDraft.isRandomized,
          questions: questionBankDraft.questions
        };

        const result = isEditMode
          ? await window.RecruitmentStore.updateQuestionBank(form.dataset.id, payload)
          : await window.RecruitmentStore.addQuestionBank(payload);
        showSuccessPopup(isEditMode ? "Question bank berhasil diperbarui" : (payload.isPublished === "1" ? "Question bank berhasil dibuat" : "Question bank saved as draft"));
        questionBankDraft = null;
        await navigate("questions", "view", result.questionBank.id);
        return;
      }

      if (form.dataset.form === "course") {
        // Fallback modal lama juga memakai checkbox multi-position.
        data.educationLevels = [...form.querySelectorAll('input[name="educationLevels"]:checked')]
          .map((input) => input.value);
        if (mode === "create") {
          await window.RecruitmentStore.addCourse(data);
        } else {
          await window.RecruitmentStore.updateCourse(id, data);
        }
        showFlash("Course has been saved.");
      }

      closeModal();
      await render();
    } catch (error) {
      if (form.dataset.form === "question-bank-page") {
        showValidationPopup(error.message || "Please complete the question bank before publishing.");
        return;
      }

      showFlash(error.message || "Data could not be saved.", "danger");
    }
  });

  window.addEventListener("popstate", render);
  // Render pertama saat halaman admin dibuka.
  render();
})();
