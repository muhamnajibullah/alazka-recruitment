(function () {
  // Ubah versi ini setiap kali alur submit/token berubah agar mudah memastikan JS terbaru sudah ter-load.
  const submitApplicationVersion = "20260529-rtl-arabic";
  window.SubmitApplicationVersion = submitApplicationVersion;

  // Referensi elemen halaman form application.
  const applicationPage = document.querySelector("#applicationPage");
  const form = document.querySelector("#applicationForm");
  const formSide = document.querySelector(".form-side");
  const region = document.querySelector("#region");
  const education = document.querySelector("#education");
  const course = document.querySelector("#course");
  const statusText = document.querySelector("#status");
  const startButton = form.querySelector(".start-button");

  // Referensi elemen halaman token yang tampil setelah application berhasil tersimpan.
  const tokenPage = document.querySelector("#tokenPage");
  const tokenForm = document.querySelector("#tokenForm");
  const examToken = document.querySelector("#examToken");
  const examTokenError = document.querySelector("#examTokenError");
  const tokenStatus = document.querySelector("#tokenStatus");
  const tokenSubmitButton = document.querySelector("#tokenSubmitButton");
  const tokenBackButton = document.querySelector("#tokenBackButton");

  const testGuidePage = document.querySelector("#testGuidePage");
  const testGuideContent = document.querySelector("#testGuideContent");
  const startSelectionTestButton = document.querySelector("#startSelectionTestButton");

  // Referensi elemen halaman selection test.
  const selectionPage = document.querySelector("#selectionPage");
  const candidateHeaderName = document.querySelector("#candidateHeaderName");
  const candidateAvatar = document.querySelector("#candidateAvatar");
  const testTitle = document.querySelector("#testTitle");
  const testCandidateLine = document.querySelector("#testCandidateLine");
  const selectionTestForm = document.querySelector("#selectionTestForm");
  const prevQuestions = document.querySelector("#prevQuestions");
  const nextQuestions = document.querySelector("#nextQuestions");
  const finishTest = document.querySelector("#finishTest");
  const testPageNumbers = document.querySelector("#testPageNumbers");
  const testTimer = document.querySelector("#testTimer");
  const testTimerBox = document.querySelector(".test-timer");
  const finishConfirmModal = document.querySelector("#finishConfirmModal");
  const cancelFinishTest = document.querySelector("#cancelFinishTest");
  const confirmFinishTest = document.querySelector("#confirmFinishTest");
  const timeEndedModal = document.querySelector("#timeEndedModal");
  const goToResultButton = document.querySelector("#goToResultButton");

  // Referensi elemen halaman hasil test.
  const resultPage = document.querySelector("#resultPage");

  const questionsPerPage = 10;
  const testDurationSeconds = 60 * 60;
  const testSessionStorageKey = "recruitment.selectionTest.session";
  const mobileFormAutoScrollDurationMs = 950;
  let coursesByEducation = {};
  let coursesByRegionEducation = {};
  let testState = null;
  let pendingApplication = null;
  let pendingTest = null;
  let timerInterval = null;
  let timerDeadline = 0;
  let isSubmittingTest = false;
  let isTestCompleted = false;
  let finishConfirmResolve = null;

  // Debug ringan untuk cPanel: cek di browser console apakah versi ini yang berjalan.
  console.info(`Submit application script loaded: ${submitApplicationVersion}`);

  function testSessionSnapshot() {
    if (!testState || isTestCompleted) {
      return null;
    }

    return {
      version: 1,
      savedAt: Date.now(),
      timerDeadline,
      isSubmittingTest,
      pendingApplication,
      pendingTest,
      testState: {
        ...testState,
        multipleChoiceQuestions: undefined,
        essayQuestions: undefined
      }
    };
  }

  function saveTestSession() {
    const snapshot = testSessionSnapshot();
    if (!snapshot) {
      return;
    }

    try {
      // Debug resume: state test disimpan lokal agar refresh/offline tidak menghapus progres kandidat.
      window.localStorage.setItem(testSessionStorageKey, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("Selection test session could not be saved locally.", error);
    }
  }

  function clearTestSession() {
    window.localStorage.removeItem(testSessionStorageKey);
  }

  function finalizeStoredTestSession() {
    // Debug resume: setelah server menerima submit, state dimatikan dulu agar beforeunload tidak menyimpan ulang sesi selesai.
    isTestCompleted = true;
    clearTestSession();
    testState = null;
    pendingTest = null;
    timerDeadline = 0;
  }

  function rebuildQuestionGroups(state) {
    state.multipleChoiceQuestions = Array.isArray(state.questions)
      ? state.questions.filter((question) => question.questionType !== "essay")
      : [];
    state.essayQuestions = Array.isArray(state.questions)
      ? state.questions.filter((question) => question.questionType === "essay")
      : [];
    state.answers = state.answers || {};
    state.essayAnswers = state.essayAnswers || {};
    state.page = Number(state.page || 0);
    state.activeQuestionType = state.activeQuestionType === "essay" ? "essay" : "multiple_choice";

    if (state.multipleChoiceQuestions.length === 0 && state.essayQuestions.length > 0) {
      state.activeQuestionType = "essay";
    }

    return state;
  }

  async function restoreSavedTestSession() {
    const rawSession = window.localStorage.getItem(testSessionStorageKey);
    if (!rawSession) {
      return false;
    }

    try {
      const snapshot = JSON.parse(rawSession);
      if (!snapshot?.testState?.applicationId || !Array.isArray(snapshot.testState.questions)) {
        clearTestSession();
        return false;
      }

      try {
        const alreadySubmitted = await window.RecruitmentStore.hasFinishedSelectionTest(snapshot.testState.applicationId);
        if (alreadySubmitted) {
          // Debug resume: stale localStorage dari test yang sudah tersimpan dibersihkan agar tidak kembali ke soal.
          testState = rebuildQuestionGroups(snapshot.testState);
          finalizeStoredTestSession();
          showResultPage();
          return true;
        }
      } catch (error) {
        // Jika server sedang tidak bisa dihubungi, tetap restore lokal agar kandidat tidak kehilangan progres.
        console.warn("Could not verify saved selection test status; restoring local session.", error);
      }

      pendingApplication = snapshot.pendingApplication || null;
      pendingTest = snapshot.pendingTest || null;
      timerDeadline = Number(snapshot.timerDeadline || 0);
      testState = rebuildQuestionGroups(snapshot.testState);
      isSubmittingTest = false;
      isTestCompleted = false;

      applicationPage.hidden = true;
      tokenPage.hidden = true;
      testGuidePage.hidden = true;
      resultPage.hidden = true;
      selectionPage.hidden = false;
      renderSelectionTest();
      updateTestTimer();
      timerInterval = window.setInterval(updateTestTimer, 1000);
      window.scrollTo({ top: 0, behavior: "auto" });
      return true;
    } catch (error) {
      clearTestSession();
      return false;
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function richTextHtml(value) {
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

  function optionTextHtml(letter, text) {
    const prefix = `${letter}.`;
    return hasArabicText(text)
      ? `<span class="option-letter" aria-hidden="true">${letter}</span><span${rtlAttrs(text)}>${escapeHtml(text)}</span>`
      : `<span>${escapeHtml(`${prefix} ${text || ""}`)}</span>`;
  }

  function questionTitleHtml(displayNumber, questionText) {
    return `
      <h2 class="question-title">
        <span class="question-number">${displayNumber}.</span>
        <span${rtlAttrs(questionText)}>${richTextHtml(questionText)}</span>
      </h2>
    `;
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

  // Menampilkan pesan error di bawah field berdasarkan nama input.
  function setError(name, message) {
    const errorElement = document.querySelector(`#${name}Error`);
    if (errorElement) {
      errorElement.textContent = message;
    }
  }

  function clearErrors() {
    ["fullName", "email", "phone", "region", "education", "course"].forEach((name) => setError(name, ""));
  }

  function clearTokenError() {
    examTokenError.textContent = "";
    tokenStatus.textContent = "";
  }

  // Mengambil course dari database, tetapi education level tetap memakai 4 opsi default production.
  async function fillEducationLevels() {
    coursesByEducation = await window.RecruitmentStore.getPublishedCoursesByEducation();
    coursesByRegionEducation = coursesByEducation.coursesByRegionEducation || {};
    coursesByEducation = coursesByEducation.coursesByEducation || {};
    const currentValue = education.value;

    education.innerHTML = '<option value="">Select position</option>';
    window.RecruitmentStore.educationLevels.forEach((level) => {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      education.appendChild(option);
    });

    if (window.RecruitmentStore.educationLevels.includes(currentValue)) {
      education.value = currentValue;
    }
  }

  // Setelah education dipilih, dropdown course hanya menampilkan course yang sesuai level itu.
  function updateCourses() {
    const regionCourses = coursesByRegionEducation[region.value] || {};
    const selectedCourses = region.value
      ? (regionCourses[education.value] || [])
      : (coursesByEducation[education.value] || []);
    const currentValue = course.value;

    course.innerHTML = '<option value="">Select available course</option>';
    selectedCourses.forEach((courseName) => {
      const option = document.createElement("option");
      option.value = courseName;
      option.textContent = courseName;
      course.appendChild(option);
    });

    // Course baru bisa dipilih setelah admin membuat course aktif dan question bank-nya published.
    course.disabled = region.value === "" || education.value === "" || selectedCourses.length === 0;

    if (selectedCourses.includes(currentValue)) {
      course.value = currentValue;
    }
  }

  // Dipanggil saat halaman pertama dibuka.
  async function refreshCourseChoices() {
    try {
      await fillEducationLevels();
      updateCourses();
      statusText.textContent = "";
    } catch (error) {
      statusText.textContent = error.message || "Unable to load courses from database.";
    }
  }

  function autoScrollToMobileApplicationForm() {
    if (!formSide || window.matchMedia("(min-width: 641px)").matches || applicationPage.hidden) {
      return;
    }

    // Debug mobile: halaman awal punya hero di atas form, jadi viewport otomatis diarahkan ke Application Form.
    window.setTimeout(() => {
      const targetY = Math.max(0, formSide.getBoundingClientRect().top + window.scrollY - 8);
      animateWindowScroll(targetY, mobileFormAutoScrollDurationMs);
    }, 180);
  }

  function animateWindowScroll(targetY, durationMs) {
    const startY = window.scrollY;
    const distance = targetY - startY;
    const startedAt = performance.now();
    const easeInOut = (progress) => progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;

    function step(now) {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      window.scrollTo(0, startY + (distance * easeInOut(progress)));
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    }

    window.requestAnimationFrame(step);
  }

  function initials(name) {
    return String(name || "Candidate")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("") || "CT";
  }

  function formatTime(totalSeconds) {
    const safeSeconds = Math.max(0, totalSeconds);
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function stopTestTimer() {
    if (timerInterval) {
      window.clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function updateTestTimer() {
    if (!timerDeadline) {
      testTimer.textContent = formatTime(testDurationSeconds);
      testTimerBox.classList.remove("is-warning");
      return;
    }

    const remainingSeconds = Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000));
    testTimer.textContent = formatTime(remainingSeconds);
    testTimerBox.classList.toggle("is-warning", remainingSeconds <= 5 * 60);

    if (remainingSeconds <= 0) {
      stopTestTimer();
      closeFinishConfirm(false);
      submitSelectionTest({ skipConfirmation: true, isAutoSubmit: true });
    }
  }

  function startTestTimer() {
    stopTestTimer();
    timerDeadline = Date.now() + (testDurationSeconds * 1000);
    updateTestTimer();
    timerInterval = window.setInterval(updateTestTimer, 1000);
    saveTestSession();
  }

  function closeFinishConfirm(value) {
    finishConfirmModal.classList.remove("is-open");
    if (finishConfirmResolve) {
      finishConfirmResolve(value);
      finishConfirmResolve = null;
    }
  }

  function showFinishConfirm() {
    finishConfirmModal.classList.add("is-open");

    return new Promise((resolve) => {
      finishConfirmResolve = resolve;
      confirmFinishTest.focus();
    });
  }

  function showTestValidationPopup(message) {
    const existingPopup = document.querySelector(".test-validation-layer");
    if (existingPopup) {
      existingPopup.remove();
    }

    const popup = document.createElement("div");
    popup.className = "test-validation-layer";
    popup.innerHTML = `
      <div class="test-validation-popup" role="dialog" aria-modal="true" aria-labelledby="testValidationTitle">
        <button class="test-validation-close" type="button" data-test-validation-close aria-label="Close popup">&times;</button>
        <div class="test-validation-icon" aria-hidden="true">!</div>
        <h2 id="testValidationTitle">Validation Required</h2>
        <p>${escapeHtml(message)}</p>
        <button class="test-validation-action" type="button" data-test-validation-close>Close</button>
      </div>
    `;
    document.body.appendChild(popup);

    // Debug: popup custom menggantikan window.alert agar UI tetap konsisten dan bisa ditutup manual.
    popup.addEventListener("click", (event) => {
      if (event.target === popup || event.target.closest("[data-test-validation-close]")) {
        popup.remove();
      }
    });

    popup.querySelector("[data-test-validation-close]")?.focus();
  }

  function isMultipleChoiceComplete() {
    if (!testState || testState.multipleChoiceQuestions.length === 0) {
      return true;
    }

    // Debug: validasi ini mencegah kandidat masuk Essay sebelum semua radio MC terjawab.
    return testState.multipleChoiceQuestions.every((question, index) => {
      const answerIndex = Number.isInteger(question.sourceIndex) ? question.sourceIndex : index;
      return Boolean(testState.answers[answerIndex]);
    });
  }

  // Membentuk satu blok soal dan 4 pilihan jawaban dari data question bank.
  function multipleChoiceQuestionHtml(question, displayNumber) {
    const answerIndex = Number.isInteger(question.sourceIndex) ? question.sourceIndex : displayNumber - 1;
    const selected = testState.answers[answerIndex] || "";
    const options = [
      ["A", question.optionA],
      ["B", question.optionB],
      ["C", question.optionC],
      ["D", question.optionD]
    ];

    return `
      <section class="test-question">
        ${questionTitleHtml(displayNumber, question.questionText)}
        ${questionImageHtml(question)}
        <div class="test-options">
          ${options.map(([letter, text]) => `
            <label class="test-option">
              <input
                type="radio"
                name="question-${answerIndex}"
                value="${letter}"
                data-question-index="${answerIndex}"
                ${selected === letter ? "checked" : ""}
              >
              ${optionTextHtml(letter, text)}
            </label>
          `).join("")}
        </div>
      </section>
    `;
  }

  function essayQuestionHtml(question, displayNumber) {
    const answerIndex = Number.isInteger(question.sourceIndex) ? question.sourceIndex : displayNumber - 1;
    const value = testState.essayAnswers[answerIndex] || "";
    return `
      <section class="test-question essay-question">
        ${questionTitleHtml(displayNumber, question.questionText)}
        ${questionImageHtml(question)}
        <label class="essay-answer-field">
          <span>Your Answer</span>
          <textarea data-essay-question-index="${answerIndex}" placeholder="Write your essay answer here" dir="auto">${escapeHtml(value)}</textarea>
        </label>
      </section>
    `;
  }

  function questionTypeHeaderHtml(activeType, total) {
    return `
      <div class="test-type-tabs" aria-label="Current test section">
        <span class="test-type-pill is-active">${activeType === "essay" ? "Essay" : "Multiple Choice"}</span>
        <span class="test-type-count">${total} question${total === 1 ? "" : "s"}</span>
      </div>
    `;
  }

  // Membuat nomor pagination halaman test, satu halaman berisi maksimal 10 soal.
  function renderPageNumbers(totalPages) {
    if (totalPages <= 1) {
      testPageNumbers.innerHTML = "";
      return;
    }

    testPageNumbers.innerHTML = Array.from({ length: totalPages }, (_, index) => `
      <button
        class="test-page-button${index === testState.page ? " is-active" : ""}"
        type="button"
        data-page="${index}"
        aria-label="Open question page ${index + 1}"
      >${index + 1}</button>
    `).join("");
  }

  // Render ulang soal berdasarkan halaman aktif.
  function renderSelectionTest() {
    const activeQuestions = testState.activeQuestionType === "essay" ? testState.essayQuestions : testState.multipleChoiceQuestions;
    const totalPages = Math.max(1, Math.ceil(activeQuestions.length / questionsPerPage));
    const startIndex = testState.page * questionsPerPage;
    const visibleQuestions = activeQuestions.slice(startIndex, startIndex + questionsPerPage);

    candidateHeaderName.textContent = testState.fullName;
    candidateAvatar.textContent = initials(testState.fullName);
    testTitle.textContent = `Selection Test ${testState.education} ${testState.course} • Al-Azhar Kelapa Gading`;
    testCandidateLine.textContent = `${testState.fullName} (${testState.email})`;

    const questionItemsHtml = visibleQuestions
      .map((question, index) => testState.activeQuestionType === "essay"
        ? essayQuestionHtml(question, startIndex + index + 1)
        : multipleChoiceQuestionHtml(question, startIndex + index + 1))
      .join("");
    selectionTestForm.innerHTML = `${questionTypeHeaderHtml(testState.activeQuestionType, activeQuestions.length)}${questionItemsHtml}`;

    prevQuestions.disabled = testState.page === 0 && !(testState.activeQuestionType === "essay" && testState.multipleChoiceQuestions.length > 0);
    nextQuestions.hidden = testState.activeQuestionType === "essay"
      ? testState.page >= totalPages - 1
      : (testState.essayQuestions.length === 0 && testState.page >= totalPages - 1);
    finishTest.hidden = testState.essayQuestions.length > 0
      ? !(testState.activeQuestionType === "essay" && testState.page >= totalPages - 1)
      : testState.page < totalPages - 1;
    renderPageNumbers(totalPages);
    saveTestSession();
  }

  function showSelectionPage(test) {
    isTestCompleted = false;
    testState = rebuildQuestionGroups({
      ...test,
      page: 0,
      activeQuestionType: "multiple_choice",
      answers: {},
      essayAnswers: {}
    });
    isSubmittingTest = false;

    applicationPage.hidden = true;
    tokenPage.hidden = true;
    testGuidePage.hidden = true;
    resultPage.hidden = true;
    selectionPage.hidden = false;
    renderSelectionTest();
    startTestTimer();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function showResultPage() {
    stopTestTimer();
    finalizeStoredTestSession();
    selectionPage.hidden = true;
    tokenPage.hidden = true;
    testGuidePage.hidden = true;
    applicationPage.hidden = true;
    resultPage.hidden = false;
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  education.addEventListener("change", updateCourses);
  region.addEventListener("change", updateCourses);

  function showTokenPage(application) {
    // Jika baris ini tidak terpanggil setelah Start Test, biasanya browser masih memakai JS lama dari cache.
    pendingApplication = application;
    clearTokenError();
    examToken.value = "";
    applicationPage.hidden = true;
    selectionPage.hidden = true;
    testGuidePage.hidden = true;
    resultPage.hidden = true;
    tokenPage.hidden = false;
    window.scrollTo({ top: 0, behavior: "auto" });
    examToken.focus();
  }

  function showApplicationPageFromToken() {
    tokenPage.hidden = true;
    testGuidePage.hidden = true;
    applicationPage.hidden = false;
    pendingApplication = null;
    pendingTest = null;
    clearTokenError();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showTimeEndedPopup() {
    timeEndedModal.classList.add("is-open");
    goToResultButton.focus();
  }

  examToken.addEventListener("input", () => {
    examToken.value = examToken.value.replace(/\D/g, "").slice(0, 4);
    clearTokenError();
  });

  function showTestGuidePage(test) {
    pendingTest = test;
    const multipleChoiceCount = test.questions.filter((question) => question.questionType !== "essay").length;
    const essayCount = test.questions.filter((question) => question.questionType === "essay").length;
    const sections = [
      multipleChoiceCount ? `<li><strong>Multiple Choice</strong><span>${multipleChoiceCount} question${multipleChoiceCount === 1 ? "" : "s"}, scored automatically.</span></li>` : "",
      essayCount ? `<li><strong>Essay</strong><span>${essayCount} question${essayCount === 1 ? "" : "s"}, reviewed manually by admin.</span></li>` : ""
    ].join("");

    testGuideContent.innerHTML = `
      <p>The selection test has a total duration of 60 minutes. The timer starts after you press Start Test.</p>
      <ul>${sections}</ul>
      <p>${multipleChoiceCount && essayCount ? "You will answer Multiple Choice first, then continue to Essay." : "You will only answer the available section for this test."}</p>
    `;

    applicationPage.hidden = true;
    tokenPage.hidden = true;
    selectionPage.hidden = true;
    resultPage.hidden = true;
    testGuidePage.hidden = false;
    window.scrollTo({ top: 0, behavior: "auto" });
    startSelectionTestButton.focus();
  }

  // Submit form hanya menyimpan application; token diminta pada halaman khusus setelah ini.
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const data = Object.fromEntries(new FormData(form).entries());
    clearErrors();
    startButton.disabled = true;
    statusText.textContent = "Saving application data...";

    try {
      const application = await window.RecruitmentStore.addApplication(data);
      statusText.textContent = "";
      // Jangan panggil getSelectionTest di sini. Token wajib diminta dulu pada halaman token.
      showTokenPage(application);
    } catch (error) {
      if (error.errors) {
        Object.entries(error.errors).forEach(([name, message]) => setError(name, message));
      }

      statusText.textContent = error.message || "Unable to start selection test.";
    } finally {
      startButton.disabled = false;
    }
  });

  // Validasi token dilakukan saat kandidat menekan Continue di halaman token.
  tokenForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearTokenError();

    if (!pendingApplication) {
      tokenStatus.textContent = "Please submit your application data first.";
      return;
    }

    const token = examToken.value.trim();
    if (!/^\d{4}$/.test(token)) {
      examTokenError.textContent = "Token is not valid.";
      return;
    }

    tokenSubmitButton.disabled = true;
    tokenStatus.textContent = "Checking token...";

    try {
      const test = await window.RecruitmentStore.getSelectionTest(pendingApplication.id, token);
      tokenStatus.textContent = "";
      showTestGuidePage(test);
    } catch (error) {
      examTokenError.textContent = "Token is not valid.";
      tokenStatus.textContent = "";
    } finally {
      tokenSubmitButton.disabled = false;
    }
  });

  tokenBackButton.addEventListener("click", showApplicationPageFromToken);
  startSelectionTestButton.addEventListener("click", () => {
    if (pendingTest) {
      showSelectionPage(pendingTest);
    }
  });

  // Simpan jawaban kandidat setiap radio button berubah.
  selectionTestForm.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-question-index]");
    if (!input || !testState) {
      return;
    }

    testState.answers[Number(input.dataset.questionIndex)] = input.value;
    saveTestSession();
  });

  selectionTestForm.addEventListener("input", (event) => {
    const textarea = event.target.closest("textarea[data-essay-question-index]");
    if (!textarea || !testState) {
      return;
    }

    testState.essayAnswers[Number(textarea.dataset.essayQuestionIndex)] = textarea.value;
    saveTestSession();
  });

  prevQuestions.addEventListener("click", () => {
    if (!testState || testState.page === 0) {
      if (testState?.activeQuestionType === "essay" && testState.multipleChoiceQuestions.length > 0) {
        testState.activeQuestionType = "multiple_choice";
        testState.page = Math.max(0, Math.ceil(testState.multipleChoiceQuestions.length / questionsPerPage) - 1);
        renderSelectionTest();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }

    testState.page--;
    renderSelectionTest();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  nextQuestions.addEventListener("click", () => {
    if (!testState) {
      return;
    }

    const activeQuestions = testState.activeQuestionType === "essay" ? testState.essayQuestions : testState.multipleChoiceQuestions;
    const totalPages = Math.ceil(activeQuestions.length / questionsPerPage);
    if (testState.page < totalPages - 1) {
      testState.page++;
      renderSelectionTest();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    if (testState.activeQuestionType === "multiple_choice" && testState.essayQuestions.length > 0) {
      if (!isMultipleChoiceComplete()) {
        showTestValidationPopup("Please finish multiple choice first.");
        return;
      }

      testState.activeQuestionType = "essay";
      testState.page = 0;
      renderSelectionTest();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  testPageNumbers.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button || !testState) {
      return;
    }

    testState.page = Number(button.dataset.page);
    renderSelectionTest();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  async function submitSelectionTest({ skipConfirmation = false, isAutoSubmit = false } = {}) {
    if (!testState || isSubmittingTest) {
      return;
    }

    if (!skipConfirmation) {
      const confirmed = await showFinishConfirm();
      if (!confirmed) {
        return;
      }
    }

    isSubmittingTest = true;
    finishTest.disabled = true;
    finishTest.textContent = isAutoSubmit ? "Time is up..." : "Saving...";

    try {
      await window.RecruitmentStore.finishSelectionTest({
        applicationId: testState.applicationId,
        questionBankId: testState.questionBankId,
        answers: testState.answers,
        essayAnswers: testState.essayAnswers
      });
      if (isAutoSubmit) {
        stopTestTimer();
        finalizeStoredTestSession();
        selectionPage.hidden = true;
        showTimeEndedPopup();
      } else {
        showResultPage();
      }
    } catch (error) {
      showTestValidationPopup(error.message || "Unable to finish selection test.");
      isSubmittingTest = false;
      finishTest.disabled = false;
      finishTest.textContent = "Finish";
      return;
    } finally {
      if (!isSubmittingTest) {
        finishTest.disabled = false;
        finishTest.textContent = "Finish";
      }
    }
  }

  finishConfirmModal.addEventListener("click", (event) => {
    if (event.target === finishConfirmModal) {
      closeFinishConfirm(false);
    }
  });

  cancelFinishTest.addEventListener("click", () => closeFinishConfirm(false));
  confirmFinishTest.addEventListener("click", () => closeFinishConfirm(true));
  goToResultButton.addEventListener("click", () => {
    timeEndedModal.classList.remove("is-open");
    showResultPage();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && finishConfirmModal.classList.contains("is-open")) {
      closeFinishConfirm(false);
    }
  });

  // Finish mengirim semua jawaban ke server; server menghitung benar/salah berdasarkan correctOption.
  finishTest.addEventListener("click", () => submitSelectionTest());
  window.addEventListener("beforeunload", saveTestSession);

  async function initializePage() {
    if (!(await restoreSavedTestSession())) {
      await refreshCourseChoices();
      autoScrollToMobileApplicationForm();
    }
  }

  initializePage();
})();
