<?php

declare(strict_types=1);

require_once __DIR__ . '/db.php';

// Header CORS diperlukan agar HTML yang dibuka dari Live Server port 5500/file lokal
// tetap bisa memanggil API PHP di port 8000.
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Semua response API lewat fungsi ini agar format JSON dan status code konsisten.
function respond(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

// Membersihkan input text sederhana sebelum divalidasi atau disimpan.
function cleanString($value): string
{
    return trim((string) $value);
}

// Membaca body JSON untuk endpoint finish_test.
function inputJson(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// Jawaban hanya boleh A-D agar scoring tidak menerima nilai lain.
function cleanAnswer($value): string
{
    $answer = strtoupper(cleanString($value));
    return in_array($answer, ['A', 'B', 'C', 'D'], true) ? $answer : '';
}

// Education level production tetap tersedia meskipun tabel courses masih kosong.
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

// Normalisasi Position menjaga data lama seperti "SMA" tetap cocok dengan label baru "Guru/Karyawan SMA".
function normalizeEducationLevel(string $value): string
{
    $aliases = [
        'TK' => 'Guru/Karyawan TK',
        'SD' => 'Guru/Karyawan SD',
        'SMP' => 'Guru/Karyawan SMP',
        'SMA' => 'Guru/Karyawan SMA',
    ];

    return $aliases[$value] ?? $value;
}

// Kode pendek dipakai fallback saat database lama masih menyimpan TK/SD/SMP/SMA.
function educationLevelCode(string $value): string
{
    $codes = [
        'Guru/Karyawan TK' => 'TK',
        'Guru/Karyawan SD' => 'SD',
        'Guru/Karyawan SMP' => 'SMP',
        'Guru/Karyawan SMA' => 'SMA',
    ];

    return $codes[$value] ?? $value;
}

function courseEducationLevels(string $storedValue): array
{
    // courses.education_level bisa berisi label lama ("Guru/Karyawan SD") atau JSON array baru.
    // Helper ini menjaga form kandidat tetap kompatibel dengan data lama.
    $decoded = json_decode($storedValue, true);
    if (is_array($decoded)) {
        return array_values(array_filter(array_map(static fn($level) => normalizeEducationLevel((string) $level), $decoded)));
    }

    return [normalizeEducationLevel($storedValue)];
}

function courseMatchesEducation(string $storedValue, string $education): bool
{
    $accepted = [$education, educationLevelCode($education)];
    foreach (courseEducationLevels($storedValue) as $level) {
        if (in_array($level, $accepted, true) || educationLevelCode($level) === educationLevelCode($education)) {
            return true;
        }
    }

    return false;
}

// Region dibatasi ke pilihan yang memang tersedia di dropdown form.
function allowedRegions(): array
{
    return ['Jakarta', 'Surabaya'];
}

// Mengambil course aktif yang sudah punya question bank published.
// Dengan begitu dropdown Course hanya berisi pilihan yang bisa lanjut ke selection test.
function publishedCoursesByEducation(PDO $pdo): array
{
    $stmt = $pdo->query(
        'SELECT DISTINCT c.name, c.education_level, c.region_scope
         FROM courses c
         JOIN question_banks qb
           ON qb.course_id = c.id
          AND qb.is_published = 1
         WHERE c.is_published = 1
         ORDER BY education_level ASC, name ASC'
    );

    $grouped = [];
    $groupedByRegion = [];
    foreach ($stmt->fetchAll() as $course) {
        $regionScope = (string) ($course['region_scope'] ?? 'Jakarta');
        if (!isset($groupedByRegion[$regionScope])) {
            $groupedByRegion[$regionScope] = [];
        }

        foreach (courseEducationLevels((string) $course['education_level']) as $educationLevel) {
            if (!isset($grouped[$educationLevel])) {
                $grouped[$educationLevel] = [];
            }
            if (!isset($groupedByRegion[$regionScope][$educationLevel])) {
                $groupedByRegion[$regionScope][$educationLevel] = [];
            }

            if (!in_array((string) $course['name'], $grouped[$educationLevel], true)) {
                $grouped[$educationLevel][] = (string) $course['name'];
            }
            if (!in_array((string) $course['name'], $groupedByRegion[$regionScope][$educationLevel], true)) {
                $groupedByRegion[$regionScope][$educationLevel][] = (string) $course['name'];
            }
        }
    }

    return [
        'all' => $grouped,
        'byRegion' => $groupedByRegion,
    ];
}

// Mengambil data application beserta bank soal yang sesuai course dan education level.
// Saat finish_test, questionBankId dikirim ulang agar scoring memakai bank soal yang sama dengan halaman test.
function selectionTestPayload(PDO $pdo, int $applicationId, int $questionBankId = 0, bool $randomizeForDisplay = false): array
{
    $questionBankFilter = $questionBankId > 0 ? ' AND qb.id = :question_bank_id' : '';
    $stmt = $pdo->prepare(
        'SELECT
            ta.id,
            ta.full_name,
            ta.email,
            ta.phone,
            ta.region,
            ta.education,
            ta.course,
            c.id AS course_id,
            qb.id AS question_bank_id,
            qb.is_randomized,
            qb.questions_json
         FROM teacher_applications ta
         JOIN courses c
            ON c.name = ta.course
           AND (
                c.education_level = ta.education
                OR CONCAT("Guru/Karyawan ", c.education_level) = ta.education
                OR c.education_level = REPLACE(ta.education, "Guru/Karyawan ", "")
                OR IF(JSON_VALID(c.education_level), JSON_CONTAINS(c.education_level, JSON_QUOTE(ta.education)), 0)
                OR IF(JSON_VALID(c.education_level), JSON_CONTAINS(c.education_level, JSON_QUOTE(REPLACE(ta.education, "Guru/Karyawan ", ""))), 0)
           )
           AND c.region_scope = ta.region
           AND c.is_published = 1
         JOIN question_banks qb
            ON qb.course_id = c.id
           AND qb.is_published = 1
         WHERE ta.id = :application_id
         ' . $questionBankFilter . '
         ORDER BY qb.id DESC
         LIMIT 1'
    );
    $params = [':application_id' => $applicationId];
    if ($questionBankId > 0) {
        $params[':question_bank_id'] = $questionBankId;
    }

    $stmt->execute($params);
    $row = $stmt->fetch();

    if (!$row) {
        respond(404, [
            'success' => false,
            'message' => 'Question bank for this application is not available yet.',
        ]);
    }

    $questions = json_decode((string) $row['questions_json'], true);
    if (!is_array($questions) || $questions === []) {
        respond(404, [
            'success' => false,
            'message' => 'Question bank is empty.',
        ]);
    }

    // sourceIndex menjaga scoring tetap cocok dengan urutan asli questions_json meski tampilan diacak.
    foreach ($questions as $index => &$question) {
        if (is_array($question)) {
            $question['sourceIndex'] = $index;
        }
    }
    unset($question);

    // Randomize hanya dilakukan saat soal dikirim untuk dikerjakan, bukan saat finish_test menghitung nilai.
    if ($randomizeForDisplay && (int) $row['is_randomized'] === 1) {
        shuffle($questions);
    }

    return [
        'application' => $row,
        'questions' => $questions,
    ];
}

// Menghapus kunci jawaban dari payload test agar kandidat hanya menerima teks soal dan opsi.
function publicQuestions(array $questions): array
{
    $publicQuestions = [];

    foreach ($questions as $index => $question) {
        $question = is_array($question) ? $question : [];
        $publicQuestions[] = [
            'number' => $index + 1,
            'questionText' => cleanString($question['questionText'] ?? ''),
            'optionA' => cleanString($question['optionA'] ?? ''),
            'optionB' => cleanString($question['optionB'] ?? ''),
            'optionC' => cleanString($question['optionC'] ?? ''),
            'optionD' => cleanString($question['optionD'] ?? ''),
            'sourceIndex' => (int) ($question['sourceIndex'] ?? $index),
        ];
    }

    return $publicQuestions;
}

function hasValidExamToken(PDO $pdo, string $token, string $region = ''): bool
{
    if (!preg_match('/^\d{4}$/', $token)) {
        return false;
    }

    $regionFilter = $region !== '' ? ' AND region_scope = :region_scope' : '';
    $stmt = $pdo->prepare(
        'SELECT COUNT(*)
         FROM exam_tokens
         WHERE token = :token
           AND is_active = 1
           AND (expires_at IS NULL OR expires_at > NOW())' . $regionFilter
    );
    $params = [':token' => $token];
    if ($region !== '') {
        $params[':region_scope'] = $region;
    }
    $stmt->execute($params);

    return (int) $stmt->fetchColumn() > 0;
}

try {
    $pdo = db();
} catch (Throwable $exception) {
    respond(500, [
        'success' => false,
        'message' => 'Database connection failed. Please check MySQL and db.php settings.',
    ]);
}

// Endpoint GET untuk mengisi pilihan education/course di form.
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['action'] ?? '') === 'courses') {
    $publishedCourses = publishedCoursesByEducation($pdo);
    respond(200, [
        'success' => true,
        'coursesByEducation' => $publishedCourses['all'],
        'coursesByRegionEducation' => $publishedCourses['byRegion'],
    ]);
}

// Endpoint GET untuk memulai selection test setelah application berhasil disimpan.
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['action'] ?? '') === 'test') {
    $applicationId = (int) ($_GET['application_id'] ?? 0);
    $token = cleanString($_GET['token'] ?? '');

    if ($applicationId <= 0) {
        respond(422, ['success' => false, 'message' => 'Invalid application ID.']);
    }

    $stmt = $pdo->prepare('SELECT region FROM teacher_applications WHERE id = :id');
    $stmt->execute([':id' => $applicationId]);
    $applicationRegion = (string) ($stmt->fetchColumn() ?: '');

    if (!hasValidExamToken($pdo, $token, $applicationRegion)) {
        respond(403, [
            'success' => false,
            'message' => 'Token is invalid or inactive. Please ask the recruitment admin for the active token.',
        ]);
    }

    $payload = selectionTestPayload($pdo, $applicationId, 0, true);
    $application = $payload['application'];

    respond(200, [
        'success' => true,
        'test' => [
            'applicationId' => (int) $application['id'],
            'questionBankId' => (int) $application['question_bank_id'],
            'fullName' => (string) $application['full_name'],
            'email' => (string) $application['email'],
            'phone' => (string) $application['phone'],
            'region' => (string) $application['region'],
            'education' => (string) $application['education'],
            'course' => (string) $application['course'],
            'questions' => publicQuestions($payload['questions']),
        ],
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['success' => false, 'message' => 'Method not allowed.']);
}

// Endpoint POST untuk menyelesaikan test, menghitung nilai, dan menyimpan ke test_results.
if (($_GET['action'] ?? '') === 'finish_test') {
    $data = inputJson();
    $applicationId = (int) ($data['applicationId'] ?? 0);
    $questionBankId = (int) ($data['questionBankId'] ?? 0);
    $answers = is_array($data['answers'] ?? null) ? $data['answers'] : [];

    if ($applicationId <= 0) {
        respond(422, ['success' => false, 'message' => 'Invalid application ID.']);
    }

    $payload = selectionTestPayload($pdo, $applicationId, $questionBankId);
    $application = $payload['application'];
    $questions = $payload['questions'];
    $totalQuestions = count($questions);
    $correctCount = 0;
    $resultQuestions = [];
    $cleanAnswers = [];

    foreach ($questions as $index => $question) {
        $candidateAnswer = cleanAnswer($answers[(string) $index] ?? $answers[$index] ?? '');
        $correctAnswer = cleanAnswer($question['correctOption'] ?? '');
        $isCorrect = $candidateAnswer !== '' && $candidateAnswer === $correctAnswer;

        if ($isCorrect) {
            $correctCount++;
        }

        $cleanAnswers[(string) $index] = $candidateAnswer;
        // Snapshot ini dipakai admin untuk melihat jawaban kandidat dan jawaban benar saat view result.
        $resultQuestions[] = [
            'questionText' => cleanString($question['questionText'] ?? ''),
            'optionA' => cleanString($question['optionA'] ?? ''),
            'optionB' => cleanString($question['optionB'] ?? ''),
            'optionC' => cleanString($question['optionC'] ?? ''),
            'optionD' => cleanString($question['optionD'] ?? ''),
            'correctOption' => $correctAnswer,
            'candidateAnswer' => $candidateAnswer,
            'isCorrect' => $isCorrect,
        ];
    }

    // Rumus score: jumlah benar dibagi total soal yang tampil di selection test, lalu dikali 100.
    $wrongCount = $totalQuestions - $correctCount;
    $score = $totalQuestions > 0 ? (int) round(($correctCount / $totalQuestions) * 100) : 0;

    $stmt = $pdo->prepare(
        'INSERT INTO test_results
            (application_id, full_name, email, phone_number, region, education, course, score, correct_count, wrong_count, total_questions, questions_json, answers_json, result_at)
         VALUES
            (:application_id, :full_name, :email, :phone_number, :region, :education, :course, :score, :correct_count, :wrong_count, :total_questions, :questions_json, :answers_json, NOW())'
    );
    $stmt->execute([
        ':application_id' => (int) $application['id'],
        ':full_name' => (string) $application['full_name'],
        ':email' => (string) $application['email'],
        ':phone_number' => (string) $application['phone'],
        ':region' => (string) $application['region'],
        ':education' => (string) $application['education'],
        ':course' => (string) $application['course'],
        ':score' => $score,
        ':correct_count' => $correctCount,
        ':wrong_count' => $wrongCount,
        ':total_questions' => $totalQuestions,
        ':questions_json' => json_encode($resultQuestions, JSON_UNESCAPED_SLASHES),
        ':answers_json' => json_encode($cleanAnswers, JSON_UNESCAPED_SLASHES),
    ]);

    respond(201, [
        'success' => true,
        'message' => 'Test result has been saved.',
        'result' => [
            'id' => (int) $pdo->lastInsertId(),
            'fullName' => (string) $application['full_name'],
            'region' => (string) $application['region'],
            'education' => (string) $application['education'],
            'course' => (string) $application['course'],
            'score' => $score,
            'correctCount' => $correctCount,
            'wrongCount' => $wrongCount,
            'totalQuestions' => $totalQuestions,
        ],
    ]);
}

// Endpoint POST menerima submit form pelamar.
$fullName = cleanString($_POST['fullName'] ?? '');
$email = cleanString($_POST['email'] ?? '');
$phone = cleanString($_POST['phone'] ?? '');
$region = cleanString($_POST['region'] ?? '');
$education = normalizeEducationLevel(cleanString($_POST['education'] ?? ''));
$course = cleanString($_POST['course'] ?? '');
$examToken = cleanString($_POST['examToken'] ?? '');

$errors = [];
$nameLength = function_exists('mb_strlen') ? mb_strlen($fullName) : strlen($fullName);
$publishedCourses = publishedCoursesByEducation($pdo);
$coursesByEducation = $publishedCourses['byRegion'][$region] ?? [];

// Validasi di backend tetap wajib meskipun frontend juga bisa menampilkan error.
if ($nameLength < 3) {
    $errors['fullName'] = 'Please enter at least 3 characters.';
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors['email'] = 'Please enter a valid email address.';
}

if (!preg_match('/^[0-9+\-\s()]{8,20}$/', $phone)) {
    $errors['phone'] = 'Please enter a valid phone number.';
}

if (!in_array($region, allowedRegions(), true)) {
    $errors['region'] = 'Please select your region.';
}

if (!in_array($education, allowedEducationLevels(), true)) {
    $errors['education'] = 'Please select your position.';
}

if (!isset($coursesByEducation[$education]) || !in_array($course, $coursesByEducation[$education], true)) {
    $errors['course'] = 'Please select an available course.';
}

if (!hasValidExamToken($pdo, $examToken, $region)) {
    $errors['examToken'] = 'Please enter the active 4 digit exam token.';
}

if ($errors === []) {
    $stmt = $pdo->prepare(
        'SELECT c.education_level
         FROM courses c
         JOIN question_banks qb ON qb.course_id = c.id AND qb.is_published = 1
         WHERE c.name = :course
           AND c.region_scope = :region_scope
           AND c.is_published = 1'
    );
    $stmt->execute([
        ':course' => $course,
        ':region_scope' => $region,
    ]);

    $hasMatchingCourse = false;
    foreach ($stmt->fetchAll() as $courseRow) {
        if (courseMatchesEducation((string) $courseRow['education_level'], $education)) {
            $hasMatchingCourse = true;
            break;
        }
    }

    if (!$hasMatchingCourse) {
        $errors['course'] = 'Selection test for this course is not available yet.';
    }
}

if ($errors !== []) {
    respond(422, [
        'success' => false,
        'message' => 'Please complete the highlighted fields.',
        'errors' => $errors,
    ]);
}

try {
    // Setelah valid, data pelamar disimpan ke tabel teacher_applications.
    $stmt = $pdo->prepare(
        'INSERT INTO teacher_applications
            (full_name, email, phone, region, education, course, submitted_at)
         VALUES
            (:full_name, :email, :phone, :region, :education, :course, NOW())'
    );

    $stmt->execute([
        ':full_name' => $fullName,
        ':email' => $email,
        ':phone' => $phone,
        ':region' => $region,
        ':education' => $education,
        ':course' => $course,
    ]);

    respond(201, [
        'success' => true,
        'message' => 'Application saved successfully.',
        'application' => [
            'id' => (int) $pdo->lastInsertId(),
            'fullName' => $fullName,
            'email' => $email,
            'phone' => $phone,
            'region' => $region,
            'education' => $education,
            'course' => $course,
        ],
    ]);
} catch (Throwable $exception) {
    error_log($exception->getMessage());
    respond(500, [
        'success' => false,
        'message' => 'Unable to save application to database.',
    ]);
}
