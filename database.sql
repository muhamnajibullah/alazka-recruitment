-- Jalankan file ini di phpMyAdmin/MySQL kalau ingin membuat database secara manual.
-- db.php juga bisa membuat tabel otomatis saat API pertama kali diakses.
-- CREATE DATABASE IF NOT EXISTS recruitment_karyawan
--   CHARACTER SET utf8mb4
--   COLLATE utf8mb4_unicode_ci;

-- USE recruitment_karyawan;

-- Data pelamar yang masuk dari submit_application.html.
CREATE TABLE IF NOT EXISTS teacher_applications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  region VARCHAR(80) NOT NULL DEFAULT '',
  education VARCHAR(80) NOT NULL,
  course VARCHAR(100) NOT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_teacher_applications_email (email),
  INDEX idx_teacher_applications_submitted_at (submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hasil test kandidat yang ditampilkan pada menu Test Results > History.
-- Kolomnya mengikuti tabel UI: Name, Email, Phone Number, Region, Course, Score, dan Date.
CREATE TABLE IF NOT EXISTS test_results (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  application_id INT UNSIGNED NULL,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  phone_number VARCHAR(30) NOT NULL,
  region VARCHAR(80) NOT NULL DEFAULT '',
  education VARCHAR(80) NOT NULL DEFAULT '',
  course VARCHAR(100) NOT NULL,
  score INT UNSIGNED NOT NULL DEFAULT 0,
  correct_count INT UNSIGNED NOT NULL DEFAULT 0,
  wrong_count INT UNSIGNED NOT NULL DEFAULT 0,
  total_questions INT UNSIGNED NOT NULL DEFAULT 0,
  questions_json LONGTEXT NULL,
  answers_json LONGTEXT NULL,
  result_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_test_results_application (application_id),
  INDEX idx_test_results_email (email),
  INDEX idx_test_results_course (course),
  INDEX idx_test_results_score (score),
  INDEX idx_test_results_result_at (result_at),
  CONSTRAINT fk_test_results_application
    FOREIGN KEY (application_id) REFERENCES teacher_applications(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Master data course yang dikelola dari Admin Dashboard.
-- is_published dipakai sebagai status Activate/Inactivate course.
-- Course inactive tidak muncul di dropdown Create Question Bank dan Submit Application.
CREATE TABLE IF NOT EXISTS courses (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT NULL,
  education_level VARCHAR(500) NOT NULL,
  region_scope VARCHAR(80) NOT NULL DEFAULT 'Jakarta',
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_course_name_education_region (name, education_level, region_scope),
  INDEX idx_courses_published (is_published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bank soal versi baru: satu baris menyimpan banyak soal dalam questions_json.
CREATE TABLE IF NOT EXISTS question_banks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  course_id INT UNSIGNED NOT NULL,
  passing_score INT UNSIGNED NOT NULL DEFAULT 75,
  questions_json LONGTEXT NOT NULL,
  is_randomized TINYINT(1) NOT NULL DEFAULT 1,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_question_banks_course (course_id),
  INDEX idx_question_banks_published (is_published),
  CONSTRAINT fk_question_banks_course
    FOREIGN KEY (course_id) REFERENCES courses(id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Token aktif untuk membuka Selection Test.
CREATE TABLE IF NOT EXISTS exam_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  token CHAR(4) NOT NULL,
  region_scope VARCHAR(80) NOT NULL DEFAULT 'Jakarta',
  admin_user VARCHAR(80) NOT NULL DEFAULT 'admin_jakarta',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_exam_tokens_active (is_active),
  INDEX idx_exam_tokens_region_admin_active (region_scope, admin_user, is_active),
  INDEX idx_exam_tokens_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Production mode: tabel courses sengaja dibiarkan kosong.
-- Admin akan menambahkan course pertama dari Admin Dashboard.
