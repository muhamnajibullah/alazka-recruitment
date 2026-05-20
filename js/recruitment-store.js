(function () {
  // Daftar level production yang selalu tersedia di form dan dashboard.
  // Course tetap berasal dari database, jadi daftar course bisa kosong sampai admin mengisinya.
  const educationLevels = [
    "Guru/Karyawan TK",
    "Guru/Karyawan SD",
    "Guru/Karyawan SMP",
    "Guru/Karyawan SMA",
    "Cleaning Service",
    "Petugas Keamanan",
    "Driver",
    "Teknisi",
    "Petugas Perpus"
  ];

  // Saat HTML dibuka dari file lokal atau Live Server 5500, PHP tetap berjalan di port 8000.
  // Saat sudah di hosting/served oleh PHP, path API cukup relatif ke domain yang sama.
  const isLocalStaticPreview =
    ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
    window.location.port === "5500" || window.location.port === "5501";
  const apiBaseUrl = window.location.protocol === "file:" || isLocalStaticPreview
    ? "http://127.0.0.1:8000/"
    : "";

  function cleanText(value) {
    return String(value || "").trim();
  }

  function apiUrl(path) {
    return `${apiBaseUrl}${path}`;
  }

  function adminRegion() {
    return window.sessionStorage.getItem("recruitment.admin.region") || "";
  }

  // Mengubah response fetch menjadi JSON dan menyeragamkan error dari backend.
  async function parseJsonResponse(response) {
    const text = await response.text();
    let payload;

    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error("Server response is not valid JSON. Pastikan halaman dibuka lewat PHP server/hosting.");
    }

    if (!response.ok || payload.success === false) {
      const requestError = new Error(payload.message || "Request failed.");
      requestError.errors = payload.errors || {};
      throw requestError;
    }

    return payload;
  }

  // Wrapper fetch agar semua request otomatis mengirim/menunggu JSON.
  async function request(url, options = {}) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" })
      },
      ...options
    });

    return parseJsonResponse(response);
  }

  // Dipakai form submit untuk mengisi dropdown education dan course.
  async function getPublishedCoursesByEducation() {
    const payload = await request(apiUrl("submit_application.php?action=courses"));
    return {
      coursesByEducation: payload.coursesByEducation || {},
      coursesByRegionEducation: payload.coursesByRegionEducation || {}
    };
  }

  // Mengirim data pelamar ke submit_application.php.
  async function addApplication(data) {
    const formData = new FormData();
    Object.entries(data).forEach(([key, value]) => formData.append(key, cleanText(value)));

    const payload = await request(apiUrl("submit_application.php"), {
      method: "POST",
      body: formData
    });

    return payload.application;
  }

  // Mengambil soal selection test untuk application yang baru dibuat.
  async function getSelectionTest(applicationId, token) {
    const tokenQuery = `&token=${encodeURIComponent(cleanText(token))}`;
    const payload = await request(apiUrl(`submit_application.php?action=test&application_id=${encodeURIComponent(applicationId)}${tokenQuery}`));
    return payload.test;
  }

  // Mengirim jawaban selection test agar dinilai server dan disimpan ke tabel test_results.
  async function finishSelectionTest(data) {
    const payload = await request(apiUrl("submit_application.php?action=finish_test"), {
      method: "POST",
      body: JSON.stringify(data)
    });

    return payload.result;
  }

  // Mengambil snapshot data dashboard: courses, questions, dan applications.
  async function getState() {
    const payload = await request(apiUrl(`admin_api.php?action=state&region=${encodeURIComponent(adminRegion())}`));
    return {
      courses: payload.courses || [],
      questionBanks: payload.questionBanks || [],
      applications: payload.applications || [],
      activeToken: payload.activeToken || null
    };
  }

  // Semua aksi admin dikirim ke admin_api.php dengan parameter action.
  async function adminAction(action, data = {}) {
    const payload = await request(apiUrl(`admin_api.php?action=${encodeURIComponent(action)}`), {
      method: "POST",
      body: JSON.stringify({ adminRegion: adminRegion(), ...data })
    });

    return payload;
  }

  // API kecil untuk file JS lain. Dengan begini, submit/admin tidak perlu tahu detail URL PHP.
  window.RecruitmentStore = {
    educationLevels,
    getPublishedCoursesByEducation,
    addApplication,
    getSelectionTest,
    finishSelectionTest,
    getState,
    addCourse: (data) => adminAction("create_course", data),
    updateCourse: (id, data) => adminAction("update_course", { id, ...data }),
    setCourseStatus: (id, isPublished) => adminAction("set_course_status", { id, isPublished }),
    deleteCourse: (id) => adminAction("delete_course", { id }),
    addQuestionBank: (data) => adminAction("create_question_bank", data),
    updateQuestionBank: (id, data) => adminAction("update_question_bank", { id, ...data }),
    setQuestionBankStatus: (id, isPublished) => adminAction("set_question_bank_status", { id, isPublished }),
    deleteQuestionBank: (id) => adminAction("delete_question_bank", { id }),
    generateExamToken: () => adminAction("generate_exam_token"),
    sendResultEmail: (id) => adminAction("send_result_email", { id }),
    deleteApplication: (id) => adminAction("delete_application", { id }),
    resetDemoData: () => adminAction("reset_data")
  };
})();
