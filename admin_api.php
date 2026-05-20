<?php

declare(strict_types=1);

require_once __DIR__ . '/db.php';

// Header CORS diperlukan agar dashboard dari Live Server port 5500/file lokal
// tetap bisa memanggil API PHP di port 8000.
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Semua endpoint admin mengirim response lewat fungsi ini agar format JSON konsisten.
function respond(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

// Membaca body JSON dari request POST dashboard.
function inputJson(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// Helper kecil untuk normalisasi input dari frontend.
function cleanString($value): string
{
    return trim((string) $value);
}

function cleanStatus($value): int
{
    return (string) $value === '0' ? 0 : 1;
}

function cleanAnswer($value): string
{
    $answer = strtoupper(cleanString($value));
    return in_array($answer, ['A', 'B', 'C', 'D'], true) ? $answer : '';
}

function allowedRegions(): array
{
    return ['Jakarta', 'Surabaya'];
}

function adminRegionFromRequest(array $data = []): string
{
    // Region scope dikirim dari sessionStorage frontend, tapi tetap divalidasi backend.
    $region = cleanString($data['adminRegion'] ?? ($_GET['region'] ?? ''));
    return in_array($region, allowedRegions(), true) ? $region : 'Jakarta';
}

function allowedEducationLevels(): array
{
    return [
        'Guru/Karyawan TK',
        'Guru/Karyawan SD',
        'Guru/Karyawan SMP',
        'Guru/Karyawan SMA',
        'Cleaning Service',
        'Petugas Keamanan',
        'Driver',
        'Teknisi',
        'Petugas Perpus',
    ];
}

function cleanCourseEducationLevels(array $data): array
{
    // Course baru bisa dipakai beberapa posisi, jadi frontend mengirim array educationLevels.
    // educationLevel tetap dibaca sebagai fallback supaya data lama/modal lama tidak langsung rusak.
    $rawLevels = $data['educationLevels'] ?? ($data['educationLevel'] ?? []);
    if (!is_array($rawLevels)) {
        $rawLevels = [$rawLevels];
    }

    $allowed = allowedEducationLevels();
    $levels = [];
    foreach ($rawLevels as $level) {
        $level = cleanString($level);
        if (in_array($level, $allowed, true) && !in_array($level, $levels, true)) {
            $levels[] = $level;
        }
    }

    return $levels;
}

function courseEducationLevelsFromStorage(string $storedValue): array
{
    // Course position bisa format lama string biasa atau format baru JSON array.
    $decoded = json_decode($storedValue, true);
    if (is_array($decoded)) {
        return array_values(array_filter(array_map('strval', $decoded)));
    }

    return [$storedValue];
}

function courseMatchesEducation(string $storedValue, string $education): bool
{
    foreach (courseEducationLevelsFromStorage($storedValue) as $level) {
        if ($level === $education || $level === str_replace('Guru/Karyawan ', '', $education) || 'Guru/Karyawan ' . $level === $education) {
            return true;
        }
    }

    return false;
}

function passingScoreForResult(PDO $pdo, array $result, string $adminRegion): int
{
    $stmt = $pdo->prepare(
        'SELECT c.education_level, qb.passing_score
         FROM question_banks qb
         JOIN courses c ON c.id = qb.course_id
         WHERE c.name = :course
           AND c.region_scope = :region_scope
           AND qb.is_published = 1
         ORDER BY qb.id DESC'
    );
    $stmt->execute([
        ':course' => (string) $result['course'],
        ':region_scope' => $adminRegion,
    ]);

    foreach ($stmt->fetchAll() as $bank) {
        if (courseMatchesEducation((string) $bank['education_level'], (string) $result['education'])) {
            return (int) $bank['passing_score'];
        }
    }

    return 75;
}

function resultHasPassed(PDO $pdo, array $result, string $adminRegion): bool
{
    return (int) $result['score'] >= passingScoreForResult($pdo, $result, $adminRegion);
}

function appBaseUrl(): string
{
    $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['SERVER_PORT'] ?? '') === '443');
    $scheme = $isHttps ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $basePath = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return $scheme . '://' . $host . ($basePath === '' ? '' : $basePath);
}

function sendPassedSelectionEmail(array $result, string $adminRegion): bool
{
    $participantName = (string) $result['fullName'];
    // Position disimpan di test_results.education saat test selesai.
    // Fallback ke course menjaga email tetap informatif untuk data lama.
    $position = cleanString($result['education'] ?? '') ?: (cleanString($result['course'] ?? '') ?: 'posisi yang dilamar');
    $to = (string) $result['email'];
    // Subject dibuat dari HTML entity agar karakter dash tetap aman di editor Windows.
    $subject = html_entity_decode('Pemberitahuan Hasil Selection Test &ndash; Al-Azhar Kelapa Gading', ENT_QUOTES, 'UTF-8');
    $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    $logoUrl = appBaseUrl() . '/Image/logo%20al%20azhar%203.png';
    $safeName = htmlspecialchars($participantName, ENT_QUOTES, 'UTF-8');
    $safePosition = htmlspecialchars($position, ENT_QUOTES, 'UTF-8');

    $body = '
      <div style="font-family: Poppins, Arial, sans-serif; color: #172033; line-height: 1.65; max-width: 720px;">
        <div style="margin-bottom: 22px;">
          <img src="' . htmlspecialchars($logoUrl, ENT_QUOTES, 'UTF-8') . '" alt="Al-Azhar Kelapa Gading" style="width: 82px; height: auto;">
        </div>
        <p>Assalamu&rsquo;alaikum Warahmatullahi Wabarakatuh,</p>
        <p>Yth. Bapak/Ibu <strong>' . $safeName . '</strong>,</p>
        <p>Segala puji bagi Allah SWT atas rahmat dan karunia-Nya.</p>
        <p>Kami mengucapkan terima kasih atas partisipasi Bapak/Ibu dalam proses Selection Test Penerimaan <strong>' . $safePosition . '</strong> di Al-Azhar Kelapa Gading.</p>
        <p>Berdasarkan hasil evaluasi dan penilaian yang telah dilakukan, dengan ini kami menyampaikan bahwa Bapak/Ibu dinyatakan <strong>LULUS</strong> pada tahap Selection Test.</p>
        <p>Semoga hasil ini menjadi langkah awal yang baik untuk dapat berkontribusi bersama dalam dunia pendidikan dan dakwah Islam.</p>
        <p>Informasi selanjutnya akan disampaikan melalui email atau kontak resmi yang telah terdaftar pada sistem kami.</p>
        <p>Jazakumullahu khairan atas perhatian dan partisipasinya.</p>
        <p>Wassalamu&rsquo;alaikum Warahmatullahi Wabarakatuh.</p>
        <p>Hormat kami,<br>Tim Recruitment<br>Al-Azhar Kelapa Gading</p>
      </div>
    ';

    $fromHost = preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? 'localhost');
    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'From: Tim Recruitment Al-Azhar Kelapa Gading <no-reply@' . $fromHost . '>',
    ];

    // Pengiriman email memakai mail() bawaan PHP. Di hosting, pastikan mail server sudah aktif.
    return mail($to, $encodedSubject, $body, implode("\r\n", $headers));
}

// Course aktif adalah course dengan is_published = 1.
// Dropdown dan API Question Bank hanya boleh memakai course aktif.
function isActiveCourse(PDO $pdo, int $courseId, string $adminRegion = ''): bool
{
    $regionFilter = $adminRegion !== '' ? ' AND region_scope = :region_scope' : '';
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM courses WHERE id = :id AND is_published = 1' . $regionFilter);
    $params = [':id' => $courseId];
    if ($adminRegion !== '') {
        $params[':region_scope'] = $adminRegion;
    }
    $stmt->execute($params);
    return (int) $stmt->fetchColumn() > 0;
}

// Membersihkan dan memvalidasi kumpulan soal sebelum disimpan ke questions_json.
// Helper ini dipakai oleh create dan edit Question Bank supaya format data konsisten.
function cleanQuestionBankQuestions(array $questions): array
{
    $cleanQuestions = [];
    foreach ($questions as $index => $question) {
        $questionText = cleanString($question['questionText'] ?? '');
        $optionA = cleanString($question['optionA'] ?? '');
        $optionB = cleanString($question['optionB'] ?? '');
        $optionC = cleanString($question['optionC'] ?? '');
        $optionD = cleanString($question['optionD'] ?? '');
        $correctOption = cleanAnswer($question['correctOption'] ?? '');

        if ($questionText === '' || $optionA === '' || $optionB === '' || $optionC === '' || $optionD === '' || $correctOption === '') {
            respond(422, [
                'success' => false,
                'message' => 'Please complete question #' . ((int) $index + 1) . ' before publishing.',
            ]);
        }

        $cleanQuestions[] = [
            'questionText' => $questionText,
            'optionA' => $optionA,
            'optionB' => $optionB,
            'optionC' => $optionC,
            'optionD' => $optionD,
            'correctOption' => $correctOption,
        ];
    }

    return $cleanQuestions;
}

// Mengambil seluruh data yang dibutuhkan dashboard dalam satu request.
// Alias kolom SQL dibuat camelCase agar mudah dipakai di JavaScript.
function fetchState(PDO $pdo, string $adminRegion): array
{
    $stmt = $pdo->prepare(
        'SELECT
            id,
            name,
            description,
            education_level AS educationLevel,
            region_scope AS regionScope,
            is_published AS isPublished,
            created_at AS createdAt,
            updated_at AS updatedAt
         FROM courses
         WHERE region_scope = :region_scope
         ORDER BY id ASC'
    );
    $stmt->execute([':region_scope' => $adminRegion]);
    $courses = $stmt->fetchAll();

    foreach ($courses as &$course) {
        $levels = json_decode((string) $course['educationLevel'], true);
        $course['educationLevels'] = is_array($levels) ? $levels : [(string) $course['educationLevel']];
    }
    unset($course);

    $stmt = $pdo->prepare(
        'SELECT
            qb.id,
            qb.course_id AS courseId,
            qb.passing_score AS passingScore,
            qb.questions_json AS questionsJson,
            qb.is_randomized AS isRandomized,
            qb.is_published AS isPublished,
            qb.created_at AS createdAt,
            qb.updated_at AS updatedAt,
            c.name AS courseName,
            c.education_level AS educationLevel,
            c.region_scope AS regionScope
         FROM question_banks qb
         JOIN courses c ON c.id = qb.course_id
         WHERE c.region_scope = :region_scope
         ORDER BY qb.id DESC'
    );
    $stmt->execute([':region_scope' => $adminRegion]);
    $questionBanks = $stmt->fetchAll();

    foreach ($questionBanks as &$bank) {
        // questionsJson disimpan sebagai JSON string di MySQL, lalu dikirim sebagai array ke frontend.
        $decodedQuestions = json_decode((string) $bank['questionsJson'], true);
        $decodedLevels = json_decode((string) $bank['educationLevel'], true);
        $bank['questions'] = is_array($decodedQuestions) ? $decodedQuestions : [];
        $bank['educationLevels'] = is_array($decodedLevels) ? $decodedLevels : [(string) $bank['educationLevel']];
        unset($bank['questionsJson']);
    }
    unset($bank);

    // Test Results mengambil data dari tabel test_results, bukan dari application mentah.
    $stmt = $pdo->prepare(
        'SELECT
            tr.id,
            tr.application_id AS applicationId,
            tr.full_name AS fullName,
            tr.email,
            tr.phone_number AS phone,
            COALESCE(NULLIF(tr.region, ""), ta.region, "") AS region,
            COALESCE(NULLIF(tr.education, ""), ta.education, "") AS education,
            tr.course,
            tr.score,
            tr.correct_count AS correctCount,
            tr.wrong_count AS wrongCount,
            tr.total_questions AS totalQuestions,
            tr.questions_json AS resultQuestionsJson,
            tr.answers_json AS answersJson,
            tr.result_at AS submittedAt
         FROM test_results tr
         LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
         WHERE COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope
         ORDER BY tr.result_at DESC, tr.id DESC
         LIMIT 100'
    );
    $stmt->execute([':region_scope' => $adminRegion]);
    $applications = $stmt->fetchAll();

    foreach ($applications as &$application) {
        // Decode snapshot hasil test supaya view result bisa menampilkan jawaban kandidat dan jawaban benar.
        $decodedQuestions = json_decode((string) ($application['resultQuestionsJson'] ?? ''), true);
        $decodedAnswers = json_decode((string) ($application['answersJson'] ?? ''), true);
        $application['resultQuestions'] = is_array($decodedQuestions) ? $decodedQuestions : [];
        $application['answers'] = is_array($decodedAnswers) ? $decodedAnswers : [];
        unset($application['resultQuestionsJson'], $application['answersJson']);
    }
    unset($application);

    $stmt = $pdo->prepare(
        'SELECT
            id,
            token,
            is_active AS isActive,
            expires_at AS expiresAt,
            created_at AS createdAt,
            updated_at AS updatedAt
         FROM exam_tokens
         WHERE is_active = 1
           AND region_scope = :region_scope
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC, id DESC
         LIMIT 1'
    );
    $stmt->execute([':region_scope' => $adminRegion]);
    $activeToken = $stmt->fetch() ?: null;

    return [
        'courses' => $courses,
        'questionBanks' => $questionBanks,
        'applications' => $applications,
        'activeToken' => $activeToken,
    ];
}

try {
    $pdo = db();
    $action = (string) ($_GET['action'] ?? 'state');
    $adminRegion = adminRegionFromRequest();

    // Dashboard memanggil action=state untuk render tabel course, question, dan result.
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'state') {
        respond(200, ['success' => true, 'adminRegion' => $adminRegion] + fetchState($pdo, $adminRegion));
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(405, ['success' => false, 'message' => 'Method not allowed.']);
    }

    $data = inputJson();
    $adminRegion = adminRegionFromRequest($data);

    // Create/update course memakai blok yang sama karena field yang divalidasi identik.
    if ($action === 'create_course' || $action === 'update_course') {
        $name = cleanString($data['name'] ?? '');
        $description = cleanString($data['description'] ?? '');
        $educationLevels = cleanCourseEducationLevels($data);
        $educationLevel = json_encode($educationLevels, JSON_UNESCAPED_SLASHES);
        $isPublished = cleanStatus($data['isPublished'] ?? 1);

        if ($name === '' || $educationLevels === []) {
            respond(422, ['success' => false, 'message' => 'Course name and at least one position are required.']);
        }

        if ($action === 'create_course') {
            $stmt = $pdo->prepare(
                'INSERT INTO courses (name, description, education_level, region_scope, is_published)
                 VALUES (:name, :description, :education_level, :region_scope, :is_published)'
            );
            $stmt->execute([
                ':name' => $name,
                ':description' => $description,
                ':education_level' => $educationLevel,
                ':region_scope' => $adminRegion,
                ':is_published' => $isPublished,
            ]);

            // ID course baru dikirim balik agar frontend bisa langsung membuka halaman View Course.
            $courseId = (int) $pdo->lastInsertId();
        } else {
            $id = (int) ($data['id'] ?? 0);
            $stmt = $pdo->prepare(
                'UPDATE courses
                 SET name = :name,
                     description = :description,
                     education_level = :education_level,
                     is_published = :is_published
                 WHERE id = :id
                   AND region_scope = :region_scope'
            );
            $stmt->execute([
                ':name' => $name,
                ':description' => $description,
                ':education_level' => $educationLevel,
                ':is_published' => $isPublished,
                ':region_scope' => $adminRegion,
                ':id' => $id,
            ]);

            // Untuk update, ID berasal dari data yang dikirim frontend.
            $courseId = $id;
        }

        respond(200, [
            'success' => true,
            'message' => 'Course has been saved.',
            'course' => ['id' => $courseId],
        ]);
    }

    // Course tidak boleh dihapus kalau masih dipakai question_banks.
    if ($action === 'delete_course') {
        $id = (int) ($data['id'] ?? 0);
        if ($id <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid course ID.']);
        }

        $stmt = $pdo->prepare(
            'SELECT COUNT(*)
             FROM question_banks qb
             JOIN courses c ON c.id = qb.course_id
             WHERE qb.course_id = :course_id
               AND c.region_scope = :region_scope'
        );
        $stmt->execute([':course_id' => $id, ':region_scope' => $adminRegion]);
        $totalUsage = (int) $stmt->fetchColumn();

        if ($totalUsage > 0) {
            respond(409, [
                'success' => false,
                'message' => 'Course tidak bisa dihapus karena masih dipakai oleh question bank. Hapus question bank terkait terlebih dahulu.',
            ]);
        }

        $stmt = $pdo->prepare('DELETE FROM courses WHERE id = :id AND region_scope = :region_scope');
        $stmt->execute([':id' => $id, ':region_scope' => $adminRegion]);
        respond(200, ['success' => true, 'message' => 'Course has been deleted.']);
    }

    // Activate/inactivate course dari tombol toggle di tabel Course.
    // Nilai disimpan di kolom courses.is_published yang juga dipakai dropdown Question Bank.
    if ($action === 'set_course_status') {
        $id = (int) ($data['id'] ?? 0);
        $isPublished = cleanStatus($data['isPublished'] ?? 0);

        if ($id <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid course ID.']);
        }

        $stmt = $pdo->prepare(
            'UPDATE courses
             SET is_published = :is_published
             WHERE id = :id
               AND region_scope = :region_scope'
        );
        $stmt->execute([
            ':is_published' => $isPublished,
            ':region_scope' => $adminRegion,
            ':id' => $id,
        ]);

        respond(200, [
            'success' => true,
            'message' => $isPublished === 1 ? 'Course has been activated.' : 'Course has been inactivated.',
        ]);
    }

    if ($action === 'create_question_bank' || $action === 'update_question_bank') {
        $id = (int) ($data['id'] ?? 0);
        $courseId = (int) ($data['courseId'] ?? 0);
        $questions = is_array($data['questions'] ?? null) ? $data['questions'] : [];
        $isPublished = cleanStatus($data['isPublished'] ?? 1);
        $isRandomized = cleanStatus($data['isRandomized'] ?? 1);
        $passingScore = max(0, min(100, (int) ($data['passingScore'] ?? 75)));

        if ($action === 'update_question_bank' && $id <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid question bank ID.']);
        }

        if ($courseId <= 0 || $questions === []) {
            respond(422, ['success' => false, 'message' => 'Please select a course and add at least one question.']);
        }

        if (!isActiveCourse($pdo, $courseId, $adminRegion)) {
            respond(422, ['success' => false, 'message' => 'Please select an active course.']);
        }

        $cleanQuestions = cleanQuestionBankQuestions($questions);

        if ($action === 'create_question_bank') {
            // Satu question bank disimpan sebagai satu baris; semua soal ada di kolom questions_json.
            $stmt = $pdo->prepare(
                'INSERT INTO question_banks
                    (course_id, passing_score, questions_json, is_randomized, is_published)
                 VALUES
                    (:course_id, :passing_score, :questions_json, :is_randomized, :is_published)'
            );
            $stmt->execute([
                ':course_id' => $courseId,
                ':passing_score' => $passingScore,
                ':questions_json' => json_encode($cleanQuestions, JSON_UNESCAPED_SLASHES),
                ':is_randomized' => $isRandomized,
                ':is_published' => $isPublished,
            ]);
            $questionBankId = (int) $pdo->lastInsertId();
        } else {
            // Pastikan bank soal yang diedit memang milik region admin saat ini.
            $stmt = $pdo->prepare(
                'SELECT COUNT(*)
                 FROM question_banks qb
                 JOIN courses c ON c.id = qb.course_id
                 WHERE qb.id = :id
                   AND c.region_scope = :region_scope'
            );
            $stmt->execute([':id' => $id, ':region_scope' => $adminRegion]);
            if ((int) $stmt->fetchColumn() === 0) {
                respond(404, ['success' => false, 'message' => 'Question bank was not found for this admin region.']);
            }

            // Edit Question Bank mengganti metadata dan seluruh isi questions_json sekaligus.
            $stmt = $pdo->prepare(
                'UPDATE question_banks
                 SET course_id = :course_id,
                     passing_score = :passing_score,
                     questions_json = :questions_json,
                     is_randomized = :is_randomized,
                     is_published = :is_published
                 WHERE id = :id'
            );
            $stmt->execute([
                ':course_id' => $courseId,
                ':passing_score' => $passingScore,
                ':questions_json' => json_encode($cleanQuestions, JSON_UNESCAPED_SLASHES),
                ':is_randomized' => $isRandomized,
                ':is_published' => $isPublished,
                ':id' => $id,
            ]);
            $questionBankId = $id;
        }

        respond(200, [
            'success' => true,
            'message' => 'Question bank has been saved.',
            'saved' => count($cleanQuestions),
            'questionBank' => ['id' => $questionBankId],
        ]);
    }

    if ($action === 'delete_question_bank') {
        $id = (int) ($data['id'] ?? 0);
        $stmt = $pdo->prepare(
            'DELETE qb
             FROM question_banks qb
             JOIN courses c ON c.id = qb.course_id
             WHERE qb.id = :id
               AND c.region_scope = :region_scope'
        );
        $stmt->execute([':id' => $id, ':region_scope' => $adminRegion]);
        respond(200, ['success' => true, 'message' => 'Question bank has been deleted.']);
    }

    // Publish/unpublish question bank dari tombol toggle di tabel Question Bank.
    // Kolom ini menentukan apakah bank soal bisa dipakai pada selection test.
    if ($action === 'set_question_bank_status') {
        $id = (int) ($data['id'] ?? 0);
        $isPublished = cleanStatus($data['isPublished'] ?? 0);

        if ($id <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid question bank ID.']);
        }

        $stmt = $pdo->prepare(
            'UPDATE question_banks qb
             JOIN courses c ON c.id = qb.course_id
             SET qb.is_published = :is_published
             WHERE qb.id = :id
               AND c.region_scope = :region_scope'
        );
        $stmt->execute([
            ':is_published' => $isPublished,
            ':region_scope' => $adminRegion,
            ':id' => $id,
        ]);

        respond(200, [
            'success' => true,
            'message' => $isPublished === 1 ? 'Question bank has been published.' : 'Question bank has been unpublished.',
        ]);
    }

    // Menghapus satu data pelamar dari halaman Test Results.
    if ($action === 'delete_application') {
        $id = (int) ($data['id'] ?? 0);
        $stmt = $pdo->prepare(
            'DELETE tr
             FROM test_results tr
             LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
             WHERE tr.id = :id
               AND COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope'
        );
        $stmt->execute([':id' => $id, ':region_scope' => $adminRegion]);
        respond(200, ['success' => true, 'message' => 'Test result has been deleted.']);
    }

    if ($action === 'send_result_email') {
        $id = (int) ($data['id'] ?? 0);
        if ($id <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid test result ID.']);
        }

        $stmt = $pdo->prepare(
            'SELECT
                tr.id,
                tr.full_name AS fullName,
                tr.email,
                COALESCE(NULLIF(tr.education, ""), ta.education, "") AS education,
                tr.course,
                tr.score,
                COALESCE(NULLIF(tr.region, ""), ta.region, "") AS region
             FROM test_results tr
             LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
             WHERE tr.id = :id
               AND COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope
             LIMIT 1'
        );
        $stmt->execute([':id' => $id, ':region_scope' => $adminRegion]);
        $result = $stmt->fetch();

        if (!$result) {
            respond(404, ['success' => false, 'message' => 'Test result was not found for this admin region.']);
        }

        if (!filter_var((string) $result['email'], FILTER_VALIDATE_EMAIL)) {
            respond(422, ['success' => false, 'message' => 'Candidate email is not valid.']);
        }

        if (!resultHasPassed($pdo, $result, $adminRegion)) {
            respond(422, ['success' => false, 'message' => 'Email can only be sent to candidates who passed the selection test.']);
        }

        if (!sendPassedSelectionEmail($result, $adminRegion)) {
            respond(500, ['success' => false, 'message' => 'Unable to send email. Please check PHP mail server configuration.']);
        }

        respond(200, [
            'success' => true,
            'message' => 'Selection test result email has been sent.',
        ]);
    }

    // Generate token 4 digit baru untuk membuka halaman selection test.
    // Hanya satu token yang aktif; token lama otomatis tidak berlaku.
    if ($action === 'generate_exam_token') {
        $token = str_pad((string) random_int(0, 9999), 4, '0', STR_PAD_LEFT);

        $pdo->beginTransaction();
        $stmt = $pdo->prepare('UPDATE exam_tokens SET is_active = 0 WHERE is_active = 1 AND region_scope = :region_scope');
        $stmt->execute([':region_scope' => $adminRegion]);
        // Token hanya berlaku 10 detik dan expires_at divalidasi ulang oleh backend submit_application.php.
        // Gunakan waktu MySQL, bukan waktu PHP, agar perbandingan expires_at > NOW() tidak kena beda timezone.
        $stmt = $pdo->prepare('INSERT INTO exam_tokens (token, region_scope, is_active, expires_at, created_at) VALUES (:token, :region_scope, 1, DATE_ADD(NOW(), INTERVAL 10 SECOND), NOW())');
        $stmt->execute([':token' => $token, ':region_scope' => $adminRegion]);
        $tokenId = (int) $pdo->lastInsertId();
        $stmt = $pdo->prepare('SELECT created_at AS createdAt, expires_at AS expiresAt FROM exam_tokens WHERE id = :id');
        $stmt->execute([':id' => $tokenId]);
        $savedToken = $stmt->fetch() ?: ['createdAt' => date('Y-m-d H:i:s'), 'expiresAt' => null];
        $pdo->commit();

        respond(201, [
            'success' => true,
            'message' => 'Exam token has been generated.',
            'token' => [
                'id' => $tokenId,
                'token' => $token,
                'regionScope' => $adminRegion,
                'isActive' => 1,
                'createdAt' => (string) $savedToken['createdAt'],
                'expiresAt' => (string) $savedToken['expiresAt'],
                'updatedAt' => null,
            ],
        ]);
    }

    // Reset production/demo: kosongkan semua tabel tanpa membuat course bawaan.
    if ($action === 'reset_data') {
        $stmt = $pdo->prepare(
            'DELETE qb
             FROM question_banks qb
             JOIN courses c ON c.id = qb.course_id
             WHERE c.region_scope = :region_scope'
        );
        $stmt->execute([':region_scope' => $adminRegion]);
        $stmt = $pdo->prepare('DELETE FROM courses WHERE region_scope = :region_scope');
        $stmt->execute([':region_scope' => $adminRegion]);
        $stmt = $pdo->prepare('DELETE FROM exam_tokens WHERE region_scope = :region_scope');
        $stmt->execute([':region_scope' => $adminRegion]);
        $stmt = $pdo->prepare('DELETE FROM test_results WHERE region = :region_scope');
        $stmt->execute([':region_scope' => $adminRegion]);
        respond(200, ['success' => true, 'message' => 'Region data has been reset.']);
    }

    respond(404, ['success' => false, 'message' => 'Unknown action.']);
} catch (PDOException $exception) {
    error_log($exception->getMessage());
    respond(500, [
        'success' => false,
        'message' => 'Database error. Please check duplicate data or database permissions.',
    ]);
} catch (Throwable $exception) {
    error_log($exception->getMessage());
    respond(500, [
        'success' => false,
        'message' => 'Server error.',
    ]);
}
