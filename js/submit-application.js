(function () {
  // Referensi elemen halaman form application.
  const applicationPage = document.querySelector("#applicationPage");
  const form = document.querySelector("#applicationForm");
  const region = document.querySelector("#region");
  const education = document.querySelector("#education");
  const course = document.querySelector("#course");
  const examToken = document.querySelector("#examToken");
  const statusText = document.querySelector("#status");
  const startButton = form.querySelector(".start-button");

  // Referensi elemen halaman selection test.
  const selectionPage = document.querySelector("#selectionPage");
  const candidateHeaderName = document.querySelector("#candidateHeaderName");
  const candidateAvatar = document.querySelector("#candidateAvatar");
  const testTitle = document.querySelector("#testTitle");
  const testCandidateLine = document.querySelector("#testCandidateLine");
  const selectionTestForm = document.querySelector("#selectionTestForm");
  const testBackButton = document.querySelector("#testBackButton");
  const prevQuestions = document.querySelector("#prevQuestions");
  const nextQuestions = document.querySelector("#nextQuestions");
  const finishTest = document.querySelector("#finishTest");
  const testPageNumbers = document.querySelector("#testPageNumbers");
  const testTimer = document.querySelector("#testTimer");
  const testTimerBox = document.querySelector(".test-timer");
  const finishConfirmModal = document.querySelector("#finishConfirmModal");
  const cancelFinishTest = document.querySelector("#cancelFinishTest");
  const confirmFinishTest = document.querySelector("#confirmFinishTest");

  // Referensi elemen halaman hasil test.
  const resultPage = document.querySelector("#resultPage");

  const questionsPerPage = 10;
  const testDurationSeconds = 60 * 60;
  let coursesByEducation = {};
  let coursesByRegionEducation = {};
  let testState = null;
  let timerInterval = null;
  let timerDeadline = 0;
  let isSubmittingTest = false;
  let finishConfirmResolve = null;

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function richTextHtml(value) {
    return escapeHtml(value)
      .replace(/&lt;(\/?)(strong|em|u|s|ul|li)&gt;/g, "<$1$2>")
      .replace(/\n/g, "<br>");
  }

  // Menampilkan pesan error di bawah field berdasarkan nama input.
  function setError(name, message) {
    document.querySelector(`#${name}Error`).textContent = message;
  }

  function clearErrors() {
    ["fullName", "email", "phone", "region", "education", "course", "examToken"].forEach((name) => setError(name, ""));
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

  // Membentuk satu blok soal dan 4 pilihan jawaban dari data question bank.
  function questionHtml(question, absoluteIndex) {
    const answerIndex = Number.isInteger(question.sourceIndex) ? question.sourceIndex : absoluteIndex;
    const selected = testState.answers[answerIndex] || "";
    const options = [
      ["A", question.optionA],
      ["B", question.optionB],
      ["C", question.optionC],
      ["D", question.optionD]
    ];

    return `
      <section class="test-question">
        <h2>${absoluteIndex + 1}. ${richTextHtml(question.questionText)}</h2>
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
              <span>${letter}. ${escapeHtml(text)}</span>
            </label>
          `).join("")}
        </div>
      </section>
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
    const totalPages = Math.max(1, Math.ceil(testState.questions.length / questionsPerPage));
    const startIndex = testState.page * questionsPerPage;
    const visibleQuestions = testState.questions.slice(startIndex, startIndex + questionsPerPage);

    candidateHeaderName.textContent = testState.fullName;
    candidateAvatar.textContent = initials(testState.fullName);
    testTitle.textContent = `Selection Test ${testState.education} Teacher ${testState.course} - Al-Azhar Kelapa Gading`;
    testCandidateLine.textContent = `${testState.fullName} (${testState.email})`;

    selectionTestForm.innerHTML = visibleQuestions
      .map((question, index) => questionHtml(question, startIndex + index))
      .join("");

    prevQuestions.disabled = testState.page === 0;
    nextQuestions.hidden = testState.page >= totalPages - 1;
    finishTest.hidden = testState.page < totalPages - 1;
    renderPageNumbers(totalPages);
  }

  function showSelectionPage(test) {
    testState = {
      ...test,
      page: 0,
      answers: {}
    };
    isSubmittingTest = false;

    applicationPage.hidden = true;
    resultPage.hidden = true;
    selectionPage.hidden = false;
    renderSelectionTest();
    startTestTimer();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function showResultPage() {
    stopTestTimer();
    selectionPage.hidden = true;
    applicationPage.hidden = true;
    resultPage.hidden = false;
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  education.addEventListener("change", updateCourses);
  region.addEventListener("change", updateCourses);

  examToken.addEventListener("input", () => {
    examToken.value = examToken.value.replace(/\D/g, "").slice(0, 4);
  });

  // Submit form: simpan application, lalu langsung ambil soal selection test dari question bank.
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const data = Object.fromEntries(new FormData(form).entries());
    clearErrors();
    startButton.disabled = true;
    statusText.textContent = "Preparing selection test...";

    try {
      const application = await window.RecruitmentStore.addApplication(data);
      const test = await window.RecruitmentStore.getSelectionTest(application.id, data.examToken);
      statusText.textContent = "";
      showSelectionPage(test);
    } catch (error) {
      if (error.errors) {
        Object.entries(error.errors).forEach(([name, message]) => setError(name, message));
      }

      statusText.textContent = error.message || "Unable to start selection test.";
    } finally {
      startButton.disabled = false;
    }
  });

  // Simpan jawaban kandidat setiap radio button berubah.
  selectionTestForm.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-question-index]");
    if (!input || !testState) {
      return;
    }

    testState.answers[Number(input.dataset.questionIndex)] = input.value;
  });

  prevQuestions.addEventListener("click", () => {
    if (!testState || testState.page === 0) {
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

    const totalPages = Math.ceil(testState.questions.length / questionsPerPage);
    if (testState.page < totalPages - 1) {
      testState.page++;
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

  testBackButton.addEventListener("click", () => {
    if (!window.confirm("Back to application form? Your test answers will be cleared.")) {
      return;
    }

    selectionPage.hidden = true;
    applicationPage.hidden = false;
    testState = null;
    isSubmittingTest = false;
    stopTestTimer();
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
        answers: testState.answers
      });
      showResultPage();
    } catch (error) {
      window.alert(error.message || "Unable to finish selection test.");
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && finishConfirmModal.classList.contains("is-open")) {
      closeFinishConfirm(false);
    }
  });

  // Finish mengirim semua jawaban ke server; server menghitung benar/salah berdasarkan correctOption.
  finishTest.addEventListener("click", () => submitSelectionTest());

  refreshCourseChoices();
})();
