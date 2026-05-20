(function () {
  const authKey = "recruitment.admin.authenticated";
  const adminRegionKey = "recruitment.admin.region";
  const adminNameKey = "recruitment.admin.name";

  if (window.sessionStorage.getItem(authKey) !== "1" || !window.sessionStorage.getItem(adminRegionKey)) {
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
  let tokenTimerInterval = null;

  document.querySelectorAll(".profile-name").forEach((element) => {
    element.textContent = adminName;
  });
  document.querySelectorAll(".admin-pill").forEach((element) => {
    element.textContent = "Admin";
  });

  // State selalu diisi ulang dari MySQL lewat admin_api.php setiap render.
  let state = {
    courses: [],
    questionBanks: [],
    applications: [],
    activeToken: null
  };

  // Filter lokal untuk tabel Test Result. Draft baru diterapkan ke tabel setelah tombol Apply ditekan.
  let resultFilters = {
    course: "",
    education: ""
  };
  let resultFilterDrafts = { ...resultFilters };
  let resultSort = {
    key: "date",
    direction: "desc"
  };

  // Pagination tiap tabel disimpan terpisah agar Course, Question Bank, dan Results punya posisi sendiri.
  const pageSizeOptions = [5, 10, 15, 20, 50];
  const tablePagination = {
    course: { page: 1, pageSize: 5 },
    questions: { page: 1, pageSize: 5 },
    results: { page: 1, pageSize: 5 }
  };

  // State sementara untuk halaman Fill Question Bank. Isinya berubah saat user klik pagination soal.
  let questionBankDraft = null;
  const questionTemplatePath = "Image/template_questions_guru.xlsx";
  const questionTemplateColumns = ["questionText", "optionA", "optionB", "optionC", "optionD", "correctOption"];

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

  // Mengganti tab dashboard tanpa reload penuh, lalu render ulang data terbaru.
  async function navigate(section, action = "", id = 0) {
    const actionQuery = action ? `&action=${encodeURIComponent(action)}` : "";
    const idQuery = id ? `&id=${encodeURIComponent(id)}` : "";
    window.history.pushState({}, "", `admin_dashboard.html?section=${section}${actionQuery}${idQuery}`);
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
    return escapeHtml(value)
      .replace(/&lt;(\/?)(strong|em|u|s|ul|li)&gt;/g, "<$1$2>")
      .replace(/\n/g, "<br>");
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
      <div class="editor-textarea" contenteditable="true" data-editor-input data-placeholder="${escapeHtml(placeholder)}">${richTextHtml(value || "")}</div>
    `;
  }

  function sanitizeEditorHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
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
    return wrapper.innerHTML;
  }

  function syncEditorValue(editor) {
    const shell = editor.closest(".editor-shell");
    const value = shell?.querySelector(".editor-value");
    if (value) {
      value.value = sanitizeEditorHtml(editor.innerHTML);
    }
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

  function normalizeTemplateCell(value) {
    return String(value ?? "").trim();
  }

  function createImportPreviewRow(row, index) {
    const question = {
      questionText: normalizeTemplateCell(row.questionText),
      optionA: normalizeTemplateCell(row.optionA),
      optionB: normalizeTemplateCell(row.optionB),
      optionC: normalizeTemplateCell(row.optionC),
      optionD: normalizeTemplateCell(row.optionD),
      correctOption: normalizeTemplateCell(row.correctOption).toUpperCase()
    };
    const errors = [];

    if (!question.questionText) errors.push("questionText wajib diisi");
    if (!question.optionA) errors.push("optionA wajib diisi");
    if (!question.optionB) errors.push("optionB wajib diisi");
    if (!question.optionC) errors.push("optionC wajib diisi");
    if (!question.optionD) errors.push("optionD wajib diisi");
    if (!["A", "B", "C", "D"].includes(question.correctOption)) errors.push("correctOption harus A/B/C/D");

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
    return ["questionText", "optionA", "optionB", "optionC", "optionD", "correctOption"]
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

  // Request utama dashboard untuk mengambil data courses/questions/applications.
  async function loadState() {
    state = await window.RecruitmentStore.getState();
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
      totalQuestions: state.questionBanks
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
    return numericResultScore(result) >= passingScoreForResult(result);
  }

  function resultStatusHtml(result) {
    const passed = hasPassedResult(result);
    return `<span class="status-pill${passed ? "" : " is-draft"}">${passed ? "Passed" : "Not Passed"}</span>`;
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
    const values = state.applications
      .map((application) => String(application[key] || "").trim())
      .filter(Boolean);

    return [...new Set([...defaults, ...values])].sort((a, b) => a.localeCompare(b));
  }

  function resultFilterOptions(key, placeholder, selectedValue, defaults = []) {
    return [
      `<option value="">${escapeHtml(placeholder)}</option>`,
      ...uniqueResultOptions(key, defaults).map((value) => (
        `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(value)}</option>`
      ))
    ].join("");
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
          <label class="filter-inline-field">
            <span class="sr-only">Course</span>
            <select name="course">
              ${resultFilterOptions("course", "All Course", resultFilterDrafts.course)}
            </select>
          </label>
          <label class="filter-inline-field">
            <span class="sr-only">Position</span>
            <select name="education">
              ${resultFilterOptions("education", "All Position", resultFilterDrafts.education, window.RecruitmentStore.educationLevels)}
            </select>
          </label>
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

  // Membuat HTML tabel Course dari state.courses.
  function renderCourses() {
    const allCourses = coursesWithTotals();
    const { rows: courses } = tablePageSlice("course", allCourses);
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
            <span class="count-badge">${allCourses.length} course</span>
          </div>
          <button class="create-btn" type="button" data-action="create-course">
            <span>Create Course</span>
            <i data-lucide="plus"></i>
          </button>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 25%;">Name <i class="sort-icon" data-lucide="arrow-down"></i></th>
                <th style="width: 25%;">Position</th>
                <th style="width: 20%;">Status</th>
                <th style="width: 30%;">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${allCourses.length ? "" : '<div class="empty-state">No courses found.</div>'}
        ${tableFooterHtml("course", allCourses.length)}
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
      questionCount: (bank.questions || []).length
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
    const allApplications = sortedResultApplications(filteredResultApplications());
    const { rows: applications } = tablePageSlice("results", allApplications);
    const rows = applications.map((result) => {
      const passed = hasPassedResult(result);

      return `
        <tr>
          <td>${escapeHtml(result.fullName)}</td>
          <td class="result-email-cell">${escapeHtml(result.email)}</td>
          <td>${escapeHtml(result.phone)}</td>
          <td>${escapeHtml(result.education || "-")}</td>
          <td>${escapeHtml(result.course)}</td>
          <td>${escapeHtml(resultScore(result))}</td>
          <td>${resultStatusHtml(result)}</td>
          <td>
            <span class="result-date-cell">${resultDateLabel(result.submittedAt)}</span>
            <small>${resultTimeLabel(result.submittedAt)}</small>
          </td>
          <td>
            <div class="action-group result-actions">
              <button class="icon-btn view" type="button" data-action="view-test-result" data-id="${result.id}" data-tooltip="View" aria-label="View test result"><i data-lucide="eye"></i></button>
              <button class="icon-btn email" type="button" data-action="send-result-email" data-id="${result.id}" data-tooltip="${passed ? "Email" : "Only Passed"}" aria-label="Email candidate"${passed ? "" : " disabled"}><i data-lucide="mail"></i></button>
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
            <span class="count-badge">${allApplications.length} test results</span>
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
                <th>Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${allApplications.length ? "" : '<div class="empty-state">No application results found for the selected filter.</div>'}
        ${tableFooterHtml("results", allApplications.length)}
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
            <span>Score</span>
            <strong>${escapeHtml(resultScore(result))}</strong>
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

  // Render utama: ambil data dari API, tentukan section aktif, lalu tampilkan tabel yang sesuai.
  async function render() {
    const section = activeSection();
    const action = activeAction();
    const recordId = activeId();
    pageTitle.textContent = sectionTitles[section];
    app.innerHTML = '<div class="empty-state">Loading data from database...</div>';

    try {
      await loadState();
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
      ${section === "course" && action !== "create" && action !== "edit" && action !== "view" ? renderCourses() : ""}
      ${section === "questions" && action === "create" ? renderCreateQuestionBankPage() : ""}
      ${section === "questions" && action === "edit" ? renderEditQuestionBankPage(recordId) : ""}
      ${section === "questions" && action === "view" ? renderViewQuestionBankPage(recordId) : ""}
      ${section === "questions" && action !== "create" && action !== "edit" && action !== "view" ? renderQuestions() : ""}
      ${section === "results" && action === "view" ? renderViewTestResultPage(recordId) : ""}
      ${section === "results" && action !== "view" ? renderResults() : ""}
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
    return window.RecruitmentStore.educationLevels.map((level) => {
      return `<option value="${escapeHtml(level)}"${level === selectedValue ? " selected" : ""}>${escapeHtml(level)}</option>`;
    }).join("");
  }

  function educationCheckboxesHtml(selectedValues = []) {
    const selected = new Set(selectedValues);
    const label = selectedValues.length ? selectedValues.join(", ") : "Select Position for the Course";
    return `
      <div class="position-multiselect" data-position-multiselect>
        <button class="position-multiselect-toggle" type="button" data-action="toggle-position-dropdown" aria-expanded="false">
          <span data-position-label>${escapeHtml(label)}</span>
          <i data-lucide="chevron-down"></i>
        </button>
        <div class="position-multiselect-menu" role="group" aria-label="Select positions for this course">
          ${window.RecruitmentStore.educationLevels.map((level) => `
            <label class="position-checkbox">
              <input type="checkbox" name="educationLevels" value="${escapeHtml(level)}"${selected.has(level) ? " checked" : ""}>
              <span>${escapeHtml(level)}</span>
            </label>
          `).join("")}
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
      questionText: "",
      optionA: "",
      optionB: "",
      optionC: "",
      optionD: "",
      correctOption: ""
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
        questionText: question.questionText || "",
        optionA: question.optionA || "",
        optionB: question.optionB || "",
        optionC: question.optionC || "",
        optionD: question.optionD || "",
        correctOption: question.correctOption || ""
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
    activeQuestion.optionA = form.elements.optionA.value;
    activeQuestion.optionB = form.elements.optionB.value;
    activeQuestion.optionC = form.elements.optionC.value;
    activeQuestion.optionD = form.elements.optionD.value;
    activeQuestion.correctOption = form.elements.correctOption.value;
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
            <p>Add a short description to help others understand this subject</p>
          </div>
          <div class="create-form-control">
            <div class="editor-shell">
              ${editorFieldHtml("questionText", question.questionText, "Enter description for the description")}
              ${editorToolbarHtml()}
            </div>
          </div>
        </div>

        <div class="question-form-row is-answer">
          <div class="create-form-copy">
            <h2>Answer</h2>
            <p>Add a short description to help others understand this subject</p>
          </div>
          <div class="answer-options">
            ${answerOptions.map(([answer, value], index) => `
              <label class="answer-option">
                <input type="radio" name="correctOption" value="${answer}"${question.correctOption === answer ? " checked" : ""}>
                <input class="create-input" name="option${answer}" type="text" value="${escapeHtml(value)}" placeholder="Option ${index + 1}">
              </label>
            `).join("")}
          </div>
        </div>
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
        <td>${escapeHtml(excerpt(row.question.questionText, 70))}</td>
        <td>${escapeHtml(row.question.correctOption || "-")}</td>
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
          <h2>Bulk Upload Question Bank</h2>
          <p>Upload questions using the provided template, preview them, then import into this question bank.</p>
        </div>
        <div class="create-form-control">
          <div class="excel-upload-panel">
            <div class="excel-upload-actions">
              <a class="secondary-btn excel-template-link" href="${questionTemplatePath}" download="template_questions_guru.xlsx">
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
    const options = [
      ["A", question.optionA],
      ["B", question.optionB],
      ["C", question.optionC],
      ["D", question.optionD]
    ];

    return `
      <article class="view-question-item">
        <h2>Question ${number}</h2>
        <p>${richTextHtml(question.questionText)}</p>
        <div class="view-answer-list">
          ${options.map(([answer, value]) => `
            <label class="view-answer-option">
              <input type="radio" disabled${question.correctOption === answer ? " checked" : ""}>
              <span>${answer}. ${escapeHtml(value)}</span>
            </label>
          `).join("")}
        </div>
      </article>
    `;
  }

  // View Test Result: menampilkan jawaban kandidat, menandai salah merah, dan jawaban benar hijau.
  function resultQuestionHtml(question, number) {
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
        <h2>${number}. ${richTextHtml(question.questionText)}</h2>
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
                <span>${answer}. ${escapeHtml(value)}${correctLabel}</span>
              </label>
            `;
          }).join("")}
        </div>
      </article>
    `;
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

  // Export hasil pelamar yang sedang ada di state menjadi file CSV.
  function exportResults() {
    const rows = state.applications.map((application) => [
      application.id,
      application.fullName,
      application.email,
      application.phone,
      application.education,
      application.course,
      resultScore(application),
      hasPassedResult(application) ? "Passed" : "Not Passed",
      application.submittedAt
    ]);
    const csv = [
      ["ID", "Full Name", "Email", "Phone", "Education", "Course", "Score", "Status", "Submitted At"],
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
      if (action === "create-course") await navigate("course", "create");
      if (action === "back-course") await navigate("course");
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
        if (questionBankDraft.questions.length < 100) {
          questionBankDraft.questions.push(createEmptyQuestionDraft());
          questionBankDraft.activeIndex = questionBankDraft.questions.length - 1;
          questionBankDraft.pagerStart = Math.max(0, questionBankDraft.questions.length - 5);
          renderQuestionEditor();
        }
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
      if (action === "generate-exam-token") {
        const confirmed = await showConfirmDialog({
          ...confirmOptions("submit"),
          title: "Generate new token?",
          message: "The previous active token will no longer open the selection test.",
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
        refreshTableSection("results");
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
        refreshTableSection("results");
      }
      if (action === "change-table-page") {
        const sectionName = trigger.dataset.sectionName;
        if (tablePagination[sectionName]) {
          tablePagination[sectionName].page = Number(trigger.dataset.page || 1);
          refreshTableSection(sectionName);
        }
      }
      if (action === "export-results") exportResults();
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
  document.addEventListener("change", (event) => {
    const pageSizeSelect = event.target.closest('[data-action="change-page-size"]');
    if (pageSizeSelect) {
      const sectionName = pageSizeSelect.dataset.sectionName;
      if (tablePagination[sectionName]) {
        tablePagination[sectionName].pageSize = Number(pageSizeSelect.value);
        tablePagination[sectionName].page = 1;
        refreshTableSection(sectionName);
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
