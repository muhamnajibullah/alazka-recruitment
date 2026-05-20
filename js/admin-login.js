(function () {
  const form = document.querySelector("#loginForm");
  const errorText = document.querySelector("#loginError");
  const username = document.querySelector("#username");
  const password = document.querySelector("#password");
  const passwordToggle = document.querySelector("#passwordToggle");

  // Login sederhana untuk preview/local development.
  // Setiap akun membawa region scope yang dipakai dashboard dan API.
  const adminAccounts = {
    admin_jakarta: { password: "Alazkajakarta", region: "Jakarta", name: "Admin Jakarta" },
    admin_surabaya: { password: "Alazkasurabaya", region: "Surabaya", name: "Admin Surabaya" }
  };
  const authKey = "recruitment.admin.authenticated";
  const regionKey = "recruitment.admin.region";
  const nameKey = "recruitment.admin.name";

  const hasCompleteSession =
    window.sessionStorage.getItem(authKey) === "1" &&
    window.sessionStorage.getItem(regionKey) &&
    window.sessionStorage.getItem(nameKey);

  // Session lama sebelum fitur Admin Jakarta/Surabaya hanya punya authKey.
  // Kalau region/name belum ada, hapus supaya user wajib login ulang.
  if (window.sessionStorage.getItem(authKey) === "1" && !hasCompleteSession) {
    window.sessionStorage.removeItem(authKey);
    window.sessionStorage.removeItem(regionKey);
    window.sessionStorage.removeItem(nameKey);
  }

  if (hasCompleteSession) {
    window.location.replace("admin_dashboard.html");
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const data = Object.fromEntries(new FormData(form).entries());
    const inputUsername = String(data.username || "").trim();
    const inputPassword = String(data.password || "");

    const account = adminAccounts[inputUsername];
    if (!account || inputPassword !== account.password) {
      errorText.textContent = "Username atau password salah.";
      return;
    }

    window.sessionStorage.setItem(authKey, "1");
    window.sessionStorage.setItem(regionKey, account.region);
    window.sessionStorage.setItem(nameKey, account.name);
    window.location.href = "admin_dashboard.html";
  });

  passwordToggle.addEventListener("click", () => {
    const isVisible = password.type === "text";
    password.type = isVisible ? "password" : "text";
    passwordToggle.setAttribute("aria-pressed", String(!isVisible));
    passwordToggle.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
    passwordToggle.innerHTML = `<i data-lucide="${isVisible ? "eye" : "eye-off"}"></i>`;

    if (window.lucide) {
      window.lucide.createIcons();
    }
  });

  username.focus();

  if (window.lucide) {
    window.lucide.createIcons();
  }
})();
