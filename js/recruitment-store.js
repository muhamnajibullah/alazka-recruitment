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
    "Petugas Perpus",
    "Purchasing Staff"
  ];

  // Preview statis seperti Live Server tidak bisa menjalankan PHP, jadi API diarahkan ke server PHP lokal.
  // Production tetap memakai path relatif agar request mengikuti domain hosting yang sedang dibuka.
  const localHosts = ["localhost", "127.0.0.1"];
  const staticPreviewPorts = ["5500", "5501"];
  const isLocalHost = localHosts.includes(window.location.hostname);
  const isLocalStaticPreview = isLocalHost && staticPreviewPorts.includes(window.location.port);
  const configuredApiBaseUrl = window.RecruitmentApiBaseUrl || "";
  const apiBaseUrl = configuredApiBaseUrl || (window.location.protocol === "file:" || isLocalStaticPreview
    ? "http://127.0.0.1:8000/"
    : "");

  function cleanText(value) {
    return String(value || "").trim();
  }

  function apiUrl(path) {
    return `${apiBaseUrl}${path}`;
  }

  function adminRegion() {
    return window.sessionStorage.getItem("recruitment.admin.region") || "";
  }

  function adminUser() {
    return window.sessionStorage.getItem("recruitment.admin.username") || "";
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
    let response;

    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" })
        },
        ...options
      });
    } catch (error) {
      // Debug koneksi: fetch gagal sebelum server mengirim JSON, biasanya PHP server belum jalan atau URL API salah.
      const localHint = apiBaseUrl.includes("127.0.0.1:8000")
        ? "Jalankan .\\start-local-server.ps1 dari folder project, atau buka halaman dari http://127.0.0.1:8000/."
        : "Pastikan file PHP sudah ter-upload di domain yang sama dan MySQL aktif.";
      throw new Error(`Cannot connect to API (${url}). ${localHint}`);
    }

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

  async function hasFinishedSelectionTest(applicationId) {
    const payload = await request(apiUrl(`submit_application.php?action=result_status&application_id=${encodeURIComponent(applicationId)}`));
    return payload.submitted === true;
  }

  // Mengambil snapshot data dashboard: courses, questions, dan applications.
  async function getState() {
    const payload = await request(apiUrl(`admin_api.php?action=state&region=${encodeURIComponent(adminRegion())}&adminUser=${encodeURIComponent(adminUser())}`));
    return {
      courses: payload.courses || [],
      questionBanks: payload.questionBanks || [],
      applications: payload.applications || [],
      activeToken: payload.activeToken || null
    };
  }

  async function getCourses() {
    const payload = await request(apiUrl(`admin_api.php?action=courses&region=${encodeURIComponent(adminRegion())}`));
    return payload.courses || [];
  }

  async function getQuestionBanks() {
    const payload = await request(apiUrl(`admin_api.php?action=question_banks&region=${encodeURIComponent(adminRegion())}`));
    return payload.questionBanks || [];
  }

  async function getQuestionBank(id) {
    const payload = await request(apiUrl(`admin_api.php?action=question_bank&region=${encodeURIComponent(adminRegion())}&id=${encodeURIComponent(id)}`));
    return payload.questionBank || null;
  }

  async function getResults(options = {}) {
    const params = new URLSearchParams({
      action: "results",
      region: adminRegion(),
      page: String(options.page || 1),
      pageSize: String(options.pageSize || 50),
      sortKey: options.sortKey || "date",
      sortDirection: options.sortDirection || "desc"
    });
    if (options.course) {
      params.set("course", options.course);
    }
    if (options.education) {
      params.set("education", options.education);
    }

    const payload = await request(apiUrl(`admin_api.php?${params.toString()}`));
    return {
      applications: payload.applications || [],
      total: Number(payload.total || 0),
      page: Number(payload.page || options.page || 1),
      pageSize: Number(payload.pageSize || options.pageSize || 50),
      filterOptions: payload.filterOptions || { course: [], education: [] }
    };
  }

  async function getRecapitulations(options = {}) {
    const params = new URLSearchParams({
      action: "recapitulations",
      region: adminRegion(),
      page: String(options.page || 1),
      pageSize: String(options.pageSize || 50),
      sortKey: options.sortKey || "name",
      sortDirection: options.sortDirection || "asc"
    });
    if (options.course) {
      params.set("course", options.course);
    }
    if (options.education) {
      params.set("education", options.education);
    }

    const payload = await request(apiUrl(`admin_api.php?${params.toString()}`));
    return {
      recapitulations: payload.recapitulations || [],
      total: Number(payload.total || 0),
      page: Number(payload.page || options.page || 1),
      pageSize: Number(payload.pageSize || options.pageSize || 50),
      filterOptions: payload.filterOptions || { course: [], education: [] }
    };
  }

  async function getRecapitulation(recapId) {
    const payload = await request(apiUrl(`admin_api.php?action=recapitulation&region=${encodeURIComponent(adminRegion())}&recapId=${encodeURIComponent(recapId)}`));
    return payload.recapitulation || null;
  }

  async function getResult(id) {
    const payload = await request(apiUrl(`admin_api.php?action=result&region=${encodeURIComponent(adminRegion())}&id=${encodeURIComponent(id)}`));
    return payload.application || null;
  }

  async function getActiveToken() {
    const payload = await request(apiUrl(`admin_api.php?action=token&region=${encodeURIComponent(adminRegion())}&adminUser=${encodeURIComponent(adminUser())}`));
    return payload.activeToken || null;
  }

  // Semua aksi admin dikirim ke admin_api.php dengan parameter action.
  async function adminAction(action, data = {}) {
    const payload = await request(apiUrl(`admin_api.php?action=${encodeURIComponent(action)}`), {
      method: "POST",
      body: JSON.stringify({ adminRegion: adminRegion(), adminUser: adminUser(), ...data })
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
    hasFinishedSelectionTest,
    getState,
    getCourses,
    getQuestionBanks,
    getQuestionBank,
    getResults,
    getRecapitulations,
    getRecapitulation,
    getResult,
    getActiveToken,
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
    sendRecapEmail: (recapId) => adminAction("send_recap_email", { recapId }),
    updateEssayReview: (id, reviews) => adminAction("update_essay_review", { id, reviews }),
    updateWeightedScore: (id, weights) => adminAction("update_weighted_score", { id, ...weights }),
    deleteApplication: (id) => adminAction("delete_application", { id }),
    resetDemoData: () => adminAction("reset_data")
  };
})();
