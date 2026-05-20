<?php

declare(strict_types=1);

// Konfigurasi default untuk local development.
// Untuk hosting atau komputer lain, buat file db.local.php agar db.php tidak perlu diedit langsung.
// $dbConfig = [
//     'host' => '',
//     'port' => '',
//     'name' => 'alazkasch_recruitment',
//     'user' => 'alazkasch',
//     'pass' => 'eX?nC_T01t1wsYrl',
// ];
$dbConfig = [
    'host' => 'localhost',
    'port' => '3306',
    'name' => 'recruitment_karyawan',
    'user' => 'root',
    'pass' => '',
];

// db.local.php bersifat opsional dan sengaja masuk .gitignore.
// Isi file-nya bisa mengikuti db.local.example.php.
$localConfigFile = __DIR__ . '/db.local.php';
if (is_file($localConfigFile)) {
    $localConfig = require $localConfigFile;
    if (is_array($localConfig)) {
        $dbConfig = array_replace($dbConfig, array_intersect_key($localConfig, $dbConfig));
    }
}

define('DB_HOST', (string) $dbConfig['host']);
define('DB_PORT', (string) $dbConfig['port']);
define('DB_NAME', (string) $dbConfig['name']);
define('DB_USER', (string) $dbConfig['user']);
define('DB_PASS', (string) $dbConfig['pass']);

// Membuat satu koneksi PDO yang dipakai ulang setiap kali fungsi db() dipanggil.
function db(): PDO
{
    static $pdo = null;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    if (!preg_match('/^[a-zA-Z0-9_]+$/', DB_NAME)) {
        throw new RuntimeException('Invalid database name.');
    }

    // Opsi ini membuat error SQL dilempar sebagai exception dan hasil SELECT berupa array associative.
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ];

    $databaseDsn = sprintf(
        'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
        DB_HOST,
        DB_PORT,
        DB_NAME
    );

    try {
        $pdo = new PDO($databaseDsn, DB_USER, DB_PASS, $options);
    } catch (PDOException $exception) {
        // Error 1049 berarti database belum ada. Di local, kita coba buat otomatis.
        // Di hosting, biasanya database dibuat dulu lewat cPanel/phpMyAdmin.
        $driverCode = (int) ($exception->errorInfo[1] ?? 0);
        if ($driverCode !== 1049) {
            throw $exception;
        }

        $serverDsn = sprintf('mysql:host=%s;port=%s;charset=utf8mb4', DB_HOST, DB_PORT);
        $serverPdo = new PDO($serverDsn, DB_USER, DB_PASS, $options);
        $serverPdo->exec(sprintf(
            'CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
            DB_NAME
        ));

        $pdo = new PDO($databaseDsn, DB_USER, DB_PASS, $options);
    }

    initDatabase($pdo);

    return $pdo;
}

// Membuat tabel yang dibutuhkan dashboard dan form jika belum tersedia.
function initDatabase(PDO $pdo): void
{
    // Tabel legacy question_bank sudah tidak dipakai. Data aktif sekarang ada di question_banks.
    $pdo->exec('DROP TABLE IF EXISTS question_bank');

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS teacher_applications (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            full_name VARCHAR(150) NOT NULL,
            email VARCHAR(150) NOT NULL,
            phone VARCHAR(30) NOT NULL,
            region VARCHAR(80) NOT NULL DEFAULT \'\',
            education VARCHAR(80) NOT NULL,
            course VARCHAR(100) NOT NULL,
            submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_teacher_applications_email (email),
            INDEX idx_teacher_applications_submitted_at (submitted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    // Detail hasil test disimpan sebagai snapshot agar view result tetap akurat walau bank soal berubah.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS test_results (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            application_id INT UNSIGNED NULL,
            full_name VARCHAR(150) NOT NULL,
            email VARCHAR(150) NOT NULL,
            phone_number VARCHAR(30) NOT NULL,
            region VARCHAR(80) NOT NULL DEFAULT \'\',
            education VARCHAR(80) NOT NULL DEFAULT \'\',
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    // is_published dipakai sebagai status Activate/Inactivate course.
    // Course inactive tidak akan dipakai dropdown Question Bank dan Submit Application.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS courses (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            description TEXT NULL,
            education_level VARCHAR(500) NOT NULL,
            region_scope VARCHAR(80) NOT NULL DEFAULT \'Jakarta\',
            is_published TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_course_name_education_region (name, education_level, region_scope),
            INDEX idx_courses_published (is_published)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS question_banks (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS exam_tokens (
            id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            token CHAR(4) NOT NULL,
            region_scope VARCHAR(80) NOT NULL DEFAULT \'Jakarta\',
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            expires_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_exam_tokens_active (is_active),
            INDEX idx_exam_tokens_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );

    ensureColumn($pdo, 'question_banks', 'is_randomized', 'TINYINT(1) NOT NULL DEFAULT 1');
    // Course position bisa berisi JSON array multi-position; ukuran lama VARCHAR(80) terlalu pendek.
    $pdo->exec('ALTER TABLE courses MODIFY education_level VARCHAR(500) NOT NULL');
    ensureColumn($pdo, 'courses', 'region_scope', "VARCHAR(80) NOT NULL DEFAULT 'Jakarta'");
    ensureColumn($pdo, 'exam_tokens', 'region_scope', "VARCHAR(80) NOT NULL DEFAULT 'Jakarta'");
    ensureColumn($pdo, 'exam_tokens', 'expires_at', 'DATETIME NULL');
    ensureCourseRegionUniqueIndex($pdo);
    ensureColumn($pdo, 'teacher_applications', 'region', "VARCHAR(80) NOT NULL DEFAULT ''");
    ensureColumn($pdo, 'test_results', 'region', "VARCHAR(80) NOT NULL DEFAULT ''");
    ensureColumn($pdo, 'test_results', 'education', "VARCHAR(80) NOT NULL DEFAULT ''");
    ensureColumn($pdo, 'test_results', 'correct_count', 'INT UNSIGNED NOT NULL DEFAULT 0');
    ensureColumn($pdo, 'test_results', 'wrong_count', 'INT UNSIGNED NOT NULL DEFAULT 0');
    ensureColumn($pdo, 'test_results', 'total_questions', 'INT UNSIGNED NOT NULL DEFAULT 0');
    ensureColumn($pdo, 'test_results', 'questions_json', 'LONGTEXT NULL');
    ensureColumn($pdo, 'test_results', 'answers_json', 'LONGTEXT NULL');
}

function ensureCourseRegionUniqueIndex(PDO $pdo): void
{
    // Index lama belum menyertakan region, sehingga course Jakarta/Surabaya dengan nama sama bisa konflik.
    $stmt = $pdo->prepare(
        'SELECT INDEX_NAME
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = "courses"
           AND INDEX_NAME IN ("unique_course_name_education", "unique_course_name_education_region")
         GROUP BY INDEX_NAME'
    );
    $stmt->execute();
    $indexes = $stmt->fetchAll(PDO::FETCH_COLUMN);

    if (in_array('unique_course_name_education', $indexes, true)) {
        $pdo->exec('ALTER TABLE courses DROP INDEX unique_course_name_education');
    }

    if (!in_array('unique_course_name_education_region', $indexes, true)) {
        $pdo->exec('ALTER TABLE courses ADD UNIQUE KEY unique_course_name_education_region (name, education_level, region_scope)');
    }
}

// Menambahkan kolom baru pada database lama tanpa perlu import ulang database.sql.
function ensureColumn(PDO $pdo, string $table, string $column, string $definition): void
{
    $stmt = $pdo->prepare(
        'SELECT COUNT(*)
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = :table_name
           AND COLUMN_NAME = :column_name'
    );
    $stmt->execute([
        ':table_name' => $table,
        ':column_name' => $column,
    ]);

    if ((int) $stmt->fetchColumn() === 0) {
        $pdo->exec(sprintf('ALTER TABLE `%s` ADD COLUMN `%s` %s', $table, $column, $definition));
    }
}
