<?php
require_once __DIR__ . '/db.php';

// Durasi token exam diatur di sini agar perubahan timer tidak perlu menyentuh query SQL panjang.
// Ubah angka detik ini saja, contoh: 10, 30, 60, 300.
const EXAM_TOKEN_EXPIRES_SECONDS = 30;

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

function cleanQuestionImage($value): string
{
    $image = cleanString($value);
    if ($image === '') {
        return '';
    }

    // Debug backend: hanya Data URL image yang dibuat uploader dashboard yang boleh masuk questions_json.
    if (!preg_match('/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]+$/i', $image)) {
        respond(422, ['success' => false, 'message' => 'Question image format is not supported.']);
    }

    if (strlen($image) > 2800000) {
        respond(422, ['success' => false, 'message' => 'Question image must be 2 MB or smaller.']);
    }

    return $image;
}

function cleanQuestionType($value): string
{
    return cleanString($value) === 'essay' ? 'essay' : 'multiple_choice';
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

function adminUserFromRequest(array $data = []): string
{
    $adminUser = strtolower(cleanString($data['adminUser'] ?? ($_GET['adminUser'] ?? '')));
    // Debug token: username dipakai sebagai scope token agar dua admin Jakarta tidak saling menonaktifkan.
    return preg_match('/^[a-z0-9_]{3,80}$/', $adminUser) ? $adminUser : 'admin_jakarta';
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
        'Purchasing Staff',
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

function normalizeCandidateEmail(string $email): string
{
    return strtolower(trim($email));
}

function normalizeCandidatePhone(string $phone): string
{
    // Normalisasi nomor membuat +62/62/nomor tanpa 0 tetap cocok sebagai peserta yang sama.
    $digits = preg_replace('/\D+/', '', $phone) ?: '';
    if (strpos($digits, '62') === 0) {
        return '0' . substr($digits, 2);
    }
    if ($digits !== '' && $digits[0] !== '0') {
        return '0' . $digits;
    }
    return $digits;
}

function candidateRecapKey(string $email, string $phone): string
{
    return normalizeCandidateEmail($email) . '|' . normalizeCandidatePhone($phone);
}

function recapHasPendingEssayScore(array $result): bool
{
    // Jika test memiliki essay dan essay score masih kosong/0, recap belum boleh diputuskan lulus atau tidak.
    return ($result['hasEssay'] ?? false) === true && (int) ($result['essayScore'] ?? 0) <= 0;
}

function questionSnapshotScores(array $questions): array
{
    $mcTotal = 0;
    $mcCorrect = 0;
    $essayTotal = 0;
    $essayCorrect = 0;
    $essayReviewed = true;

    foreach ($questions as $question) {
        if (!is_array($question)) {
            continue;
        }

        if (($question['questionType'] ?? '') === 'essay') {
            $essayTotal++;
            $essayReviewed = $essayReviewed && (($question['essayReviewed'] ?? false) === true);
            if (($question['isCorrect'] ?? false) === true) {
                $essayCorrect++;
            }
            continue;
        }

        $mcTotal++;
        if (($question['isCorrect'] ?? false) === true) {
            $mcCorrect++;
        }
    }

    return [
        'mcTotal' => $mcTotal,
        'mcCorrect' => $mcCorrect,
        'mcScore' => $mcTotal > 0 ? (int) round(($mcCorrect / $mcTotal) * 100) : 0,
        'essayTotal' => $essayTotal,
        'essayCorrect' => $essayCorrect,
        'essayScore' => $essayTotal > 0 ? (int) round(($essayCorrect / $essayTotal) * 100) : 0,
        'essayReviewed' => $essayTotal === 0 || $essayReviewed,
    ];
}

function enrichResultSummary(array &$application): void
{
    // Metadata hasil dihitung dari snapshot JSON supaya list tidak perlu mengirim seluruh jawaban kandidat.
    $decodedQuestions = json_decode((string) ($application['resultQuestionsJson'] ?? ''), true);
    $questions = is_array($decodedQuestions) ? $decodedQuestions : [];
    $essayQuestions = array_values(array_filter($questions, static fn($question) => (($question['questionType'] ?? '') === 'essay')));
    $scores = questionSnapshotScores($questions);
    $application['hasEssay'] = count($essayQuestions) > 0;
    $application['essayReviewStatus'] = count($essayQuestions) > 0 && array_reduce($essayQuestions, static fn($reviewed, $question) => $reviewed && (($question['essayReviewed'] ?? false) === true), true)
        ? 'reviewed'
        : (count($essayQuestions) > 0 ? 'waiting' : 'none');
    $application['multipleChoiceScore'] = $scores['mcScore'];
    $manualEssayScore = null;
    foreach ($questions as $question) {
        if (($question['questionType'] ?? '') === 'essay' && array_key_exists('manualEssayScore', $question)) {
            $manualEssayScore = (int) $question['manualEssayScore'];
            break;
        }
    }
    $application['essayScore'] = $manualEssayScore ?? $scores['essayScore'];
    $application['essayCorrectCount'] = $scores['essayCorrect'];
    $application['essayTotalQuestions'] = $scores['essayTotal'];
    $application['weightedScoreFinalized'] = array_reduce($questions, static fn($finalized, $question) => $finalized || (($question['weightedScoreFinalized'] ?? false) === true), false);
    unset($application['resultQuestionsJson']);
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
        $imageData = cleanQuestionImage($question['imageData'] ?? '');
        $imageName = cleanString($question['imageName'] ?? '');
        $questionType = cleanQuestionType($question['questionType'] ?? '');

        if ($questionType === 'multiple_choice' && ($questionText === '' || $optionA === '' || $optionB === '' || $optionC === '' || $optionD === '' || $correctOption === '')) {
            respond(422, [
                'success' => false,
                'message' => 'Please complete multiple choice question #' . ((int) $index + 1) . ' before publishing.',
            ]);
        }

        if ($questionType === 'essay' && $questionText === '') {
            respond(422, [
                'success' => false,
                'message' => 'Please complete question #' . ((int) $index + 1) . ' before publishing.',
            ]);
        }

        $cleanQuestions[] = [
            'questionType' => $questionType,
            'questionText' => $questionText,
            'optionA' => $optionA,
            'optionB' => $optionB,
            'optionC' => $optionC,
            'optionD' => $optionD,
            'correctOption' => $correctOption,
            'imageData' => $imageData,
            'imageName' => $imageName,
        ];
    }

    return $cleanQuestions;
}

// Mengambil seluruh data yang dibutuhkan dashboard dalam satu request.
// Alias kolom SQL dibuat camelCase agar mudah dipakai di JavaScript.
function fetchState(PDO $pdo, string $adminRegion, string $adminUser): array
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
        $essayQuestions = array_values(array_filter($application['resultQuestions'], static fn($question) => (($question['questionType'] ?? '') === 'essay')));
        $scores = questionSnapshotScores($application['resultQuestions']);
        $application['hasEssay'] = count($essayQuestions) > 0;
        $application['essayReviewStatus'] = count($essayQuestions) > 0 && array_reduce($essayQuestions, static fn($reviewed, $question) => $reviewed && (($question['essayReviewed'] ?? false) === true), true)
            ? 'reviewed'
            : (count($essayQuestions) > 0 ? 'waiting' : 'none');
        $application['multipleChoiceScore'] = $scores['mcScore'];
        $manualEssayScore = null;
        foreach ($application['resultQuestions'] as $question) {
            if (($question['questionType'] ?? '') === 'essay' && array_key_exists('manualEssayScore', $question)) {
                $manualEssayScore = (int) $question['manualEssayScore'];
                break;
            }
        }
        $application['essayScore'] = $manualEssayScore ?? $scores['essayScore'];
        $application['essayCorrectCount'] = $scores['essayCorrect'];
        $application['essayTotalQuestions'] = $scores['essayTotal'];
        // Debug frontend: marker ini mengunci tombol Give Score setelah nilai berbobot pernah disimpan.
        $application['weightedScoreFinalized'] = array_reduce($application['resultQuestions'], static fn($finalized, $question) => $finalized || (($question['weightedScoreFinalized'] ?? false) === true), false);
        unset($application['resultQuestionsJson'], $application['answersJson']);
    }
    unset($application);

    $stmt = $pdo->prepare(
        'SELECT
            id,
            token,
            admin_user AS adminUser,
            region_scope AS regionScope,
            is_active AS isActive,
            expires_at AS expiresAt,
            created_at AS createdAt,
            updated_at AS updatedAt
         FROM exam_tokens
         WHERE is_active = 1
           AND region_scope = :region_scope
           AND admin_user = :admin_user
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC, id DESC
         LIMIT 1'
    );
    $stmt->execute([':region_scope' => $adminRegion, ':admin_user' => $adminUser]);
    $activeToken = $stmt->fetch() ?: null;

    return [
        'courses' => $courses,
        'questionBanks' => $questionBanks,
        'applications' => $applications,
        'activeToken' => $activeToken,
    ];
}

function fetchCourses(PDO $pdo, string $adminRegion): array
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
        // educationLevels menjaga frontend tetap kompatibel dengan format lama string dan format baru JSON array.
        $levels = json_decode((string) $course['educationLevel'], true);
        $course['educationLevels'] = is_array($levels) ? $levels : [(string) $course['educationLevel']];
        // Total questions tidak ditampilkan di tabel Course, jadi tidak memakai JSON_LENGTH agar kompatibel dengan MySQL lama.
        $course['totalQuestions'] = 0;
    }
    unset($course);

    return $courses;
}

function fetchQuestionBanks(PDO $pdo, string $adminRegion, bool $includeQuestions = false, int $questionBankId = 0): array
{
    $idFilter = $questionBankId > 0 ? ' AND qb.id = :id' : '';
    $questionsSelect = $includeQuestions ? ', qb.questions_json AS questionsJson' : '';
    $stmt = $pdo->prepare(
        'SELECT
            qb.id,
            qb.course_id AS courseId,
            qb.passing_score AS passingScore,
            qb.is_randomized AS isRandomized,
            qb.is_published AS isPublished,
            qb.created_at AS createdAt,
            qb.updated_at AS updatedAt,
            c.name AS courseName,
            c.education_level AS educationLevel,
            c.region_scope AS regionScope
            ' . $questionsSelect . '
         FROM question_banks qb
         JOIN courses c ON c.id = qb.course_id
         WHERE c.region_scope = :region_scope' . $idFilter . '
         ORDER BY qb.id DESC'
    );
    $params = [':region_scope' => $adminRegion];
    if ($questionBankId > 0) {
        $params[':id'] = $questionBankId;
    }
    $stmt->execute($params);
    $questionBanks = $stmt->fetchAll();

    foreach ($questionBanks as &$bank) {
        // List hanya membawa jumlah soal; detail soal dikirim saat View/Edit agar payload menu tetap kecil.
        $decodedLevels = json_decode((string) $bank['educationLevel'], true);
        $bank['educationLevels'] = is_array($decodedLevels) ? $decodedLevels : [(string) $bank['educationLevel']];
        $bank['questionCount'] = 0;
        if ($includeQuestions) {
            $decodedQuestions = json_decode((string) ($bank['questionsJson'] ?? ''), true);
            $bank['questions'] = is_array($decodedQuestions) ? $decodedQuestions : [];
            $bank['questionCount'] = count($bank['questions']);
            unset($bank['questionsJson']);
        }
    }
    unset($bank);

    return $questionBanks;
}

function resultListFilters(): array
{
    // Filter list dibaca dari query string agar database hanya mengirim halaman yang dibutuhkan.
    return [
        'course' => cleanString($_GET['course'] ?? ''),
        'education' => cleanString($_GET['education'] ?? ''),
    ];
}

function resultFilterSql(array $filters, array &$params): string
{
    $where = '';

    if (($filters['course'] ?? '') !== '') {
        $where .= ' AND tr.course = :course_filter';
        $params[':course_filter'] = (string) $filters['course'];
    }

    if (($filters['education'] ?? '') !== '') {
        $where .= ' AND COALESCE(NULLIF(tr.education, ""), ta.education, "") = :education_filter';
        $params[':education_filter'] = (string) $filters['education'];
    }

    return $where;
}

function resultOrderBy(string $sortKey, string $sortDirection): string
{
    // Hanya key yang dikenal yang boleh menjadi ORDER BY supaya query tetap aman dari input bebas.
    $direction = strtolower($sortDirection) === 'asc' ? 'ASC' : 'DESC';

    if ($sortKey === 'name') {
        return 'tr.full_name ' . $direction . ', tr.id DESC';
    }

    if ($sortKey === 'score') {
        return 'tr.score ' . $direction . ', tr.id DESC';
    }

    return 'tr.result_at ' . $direction . ', tr.id ' . $direction;
}

function fetchResultTotal(PDO $pdo, string $adminRegion, array $filters = []): int
{
    $params = [':region_scope' => $adminRegion];
    $filterSql = resultFilterSql($filters, $params);
    $stmt = $pdo->prepare(
        'SELECT COUNT(*)
         FROM test_results tr
         LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
         WHERE COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope' . $filterSql
    );
    $stmt->execute($params);

    return (int) $stmt->fetchColumn();
}

function fetchResultFilterOptions(PDO $pdo, string $adminRegion): array
{
    // Option filter diambil dari seluruh result region, bukan hanya halaman yang sedang tampil.
    $stmt = $pdo->prepare(
        'SELECT DISTINCT tr.course
         FROM test_results tr
         LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
         WHERE COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope
           AND tr.course <> ""
         ORDER BY tr.course ASC'
    );
    $stmt->execute([':region_scope' => $adminRegion]);
    $courses = $stmt->fetchAll(PDO::FETCH_COLUMN);

    $stmt = $pdo->prepare(
        'SELECT DISTINCT COALESCE(NULLIF(tr.education, ""), ta.education, "") AS education
         FROM test_results tr
         LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
         WHERE COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope
           AND COALESCE(NULLIF(tr.education, ""), ta.education, "") <> ""
         ORDER BY education ASC'
    );
    $stmt->execute([':region_scope' => $adminRegion]);
    $educations = $stmt->fetchAll(PDO::FETCH_COLUMN);

    return [
        'course' => array_values(array_filter(array_map('strval', $courses))),
        'education' => array_values(array_filter(array_map('strval', $educations))),
    ];
}

function fetchResults(PDO $pdo, string $adminRegion, bool $includeDetails = false, int $resultId = 0, int $page = 1, int $pageSize = 50, array $filters = [], string $sortKey = 'date', string $sortDirection = 'desc'): array
{
    $idFilter = $resultId > 0 ? ' AND tr.id = :id' : '';
    $answersSelect = $includeDetails ? ', tr.answers_json AS answersJson' : '';
    $params = [':region_scope' => $adminRegion];
    if ($resultId > 0) {
        $params[':id'] = $resultId;
        $filterSql = '';
        $limitSql = ' LIMIT 1';
    } else {
        $filterSql = resultFilterSql($filters, $params);
        $safePage = max(1, $page);
        $safePageSize = max(5, min(100, $pageSize));
        $offset = ($safePage - 1) * $safePageSize;
        $limitSql = ' LIMIT ' . $safePageSize . ' OFFSET ' . $offset;
    }
    $orderBy = resultOrderBy($sortKey, $sortDirection);
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
            tr.result_at AS submittedAt
            ' . $answersSelect . '
         FROM test_results tr
         LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
         WHERE COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope' . $idFilter . $filterSql . '
         ORDER BY ' . $orderBy . $limitSql
    );
    $stmt->execute($params);
    $applications = $stmt->fetchAll();

    foreach ($applications as &$application) {
        // Detail pertanyaan hanya dikirim untuk View/Review/Give Score, bukan untuk tabel list.
        if ($includeDetails) {
            $decodedQuestions = json_decode((string) ($application['resultQuestionsJson'] ?? ''), true);
            $decodedAnswers = json_decode((string) ($application['answersJson'] ?? ''), true);
            $application['resultQuestions'] = is_array($decodedQuestions) ? $decodedQuestions : [];
            $application['answers'] = is_array($decodedAnswers) ? $decodedAnswers : [];
            unset($application['answersJson']);
        }
        enrichResultSummary($application);
    }
    unset($application);

    return $applications;
}

function uniqueTextList(array $values): string
{
    $cleanValues = array_values(array_unique(array_filter(array_map(static fn($value) => trim((string) $value), $values))));
    return implode(', ', $cleanValues);
}

function fetchRecapitulations(PDO $pdo, string $adminRegion, int $page = 1, int $pageSize = 50, array $filters = [], string $sortKey = 'name', string $sortDirection = 'asc'): array
{
    $params = [':region_scope' => $adminRegion];
    $filterSql = resultFilterSql($filters, $params);
    $stmt = $pdo->prepare(
        'SELECT
            tr.id,
            tr.full_name AS fullName,
            tr.email,
            tr.phone_number AS phone,
            COALESCE(NULLIF(tr.education, ""), ta.education, "") AS education,
            tr.course,
            tr.score,
            tr.questions_json AS resultQuestionsJson,
            tr.result_at AS submittedAt
         FROM test_results tr
         LEFT JOIN teacher_applications ta ON ta.id = tr.application_id
         WHERE COALESCE(NULLIF(tr.region, ""), ta.region, "") = :region_scope' . $filterSql . '
         ORDER BY tr.result_at DESC, tr.id DESC'
    );
    $stmt->execute($params);

    $groups = [];
    foreach ($stmt->fetchAll() as $row) {
        enrichResultSummary($row);
        $key = candidateRecapKey((string) $row['email'], (string) $row['phone']);
        if (!isset($groups[$key])) {
            // Satu grup mewakili satu peserta berdasarkan email + nomor telepon yang sudah dinormalisasi.
            $groups[$key] = [
                'id' => rawurlencode($key),
                'primaryResultId' => (int) $row['id'],
                'fullName' => (string) $row['fullName'],
                'email' => (string) $row['email'],
                'phone' => normalizeCandidatePhone((string) $row['phone']),
                'positions' => [],
                'courses' => [],
                'resultIds' => [],
                'scores' => [],
                'passingScores' => [],
                'hasPendingEssayScore' => false,
                'testCount' => 0,
            ];
        }

        $groups[$key]['positions'][] = (string) $row['education'];
        $groups[$key]['courses'][] = (string) $row['course'];
        $groups[$key]['resultIds'][] = (int) $row['id'];
        $groups[$key]['scores'][] = (int) $row['score'];
        // Passing grade setiap course dikumpulkan lalu dirata-ratakan untuk menentukan status akhir recap.
        $groups[$key]['passingScores'][] = passingScoreForResult($pdo, ['course' => $row['course'], 'education' => $row['education']], $adminRegion);
        $groups[$key]['hasPendingEssayScore'] = $groups[$key]['hasPendingEssayScore'] || recapHasPendingEssayScore($row);
        $groups[$key]['testCount']++;
    }

    $recaps = array_map(static function (array $group): array {
        // Status recap memakai rata-rata final score peserta dibanding rata-rata passing grade semua test yang ia kerjakan.
        $averageScore = count($group['scores']) > 0 ? (int) round(array_sum($group['scores']) / count($group['scores'])) : 0;
        $averagePassingScore = count($group['passingScores']) > 0 ? (int) round(array_sum($group['passingScores']) / count($group['passingScores'])) : 75;
        $status = $group['hasPendingEssayScore'] ? 'Waiting for Review' : ($averageScore >= $averagePassingScore ? 'Passed' : 'Not Passed');

        return [
            'id' => $group['id'],
            'primaryResultId' => $group['primaryResultId'],
            'fullName' => $group['fullName'],
            'email' => $group['email'],
            'phone' => $group['phone'],
            'education' => uniqueTextList($group['positions']),
            'course' => uniqueTextList($group['courses']),
            'resultIds' => $group['resultIds'],
            'score' => $averageScore,
            'passingScore' => $averagePassingScore,
            'status' => $status,
            'testCount' => $group['testCount'],
        ];
    }, array_values($groups));

    $direction = strtolower($sortDirection) === 'desc' ? -1 : 1;
    usort($recaps, static function (array $a, array $b) use ($sortKey, $direction): int {
        if ($sortKey === 'score') {
            return (($a['score'] <=> $b['score']) ?: strcmp($a['fullName'], $b['fullName'])) * $direction;
        }
        return strcasecmp((string) $a['fullName'], (string) $b['fullName']) * $direction;
    });

    $safePage = max(1, $page);
    $safePageSize = max(5, min(100, $pageSize));
    $offset = ($safePage - 1) * $safePageSize;

    return [
        'rows' => array_slice($recaps, $offset, $safePageSize),
        'total' => count($recaps),
        'page' => $safePage,
        'pageSize' => $safePageSize,
    ];
}

function fetchRecapitulationDetail(PDO $pdo, string $adminRegion, string $recapId): ?array
{
    $targetKey = rawurldecode($recapId);
    if ($targetKey === '') {
        return null;
    }

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
         ORDER BY tr.result_at DESC, tr.id DESC'
    );
    $stmt->execute([':region_scope' => $adminRegion]);

    $results = [];
    foreach ($stmt->fetchAll() as $row) {
        if (candidateRecapKey((string) $row['email'], (string) $row['phone']) !== $targetKey) {
            continue;
        }

        // Metadata status dihitung dulu dari questions_json, lalu detail pertanyaan dipasang untuk halaman View recap.
        $decodedQuestions = json_decode((string) ($row['resultQuestionsJson'] ?? ''), true);
        $decodedAnswers = json_decode((string) ($row['answersJson'] ?? ''), true);
        enrichResultSummary($row);
        $row['resultQuestions'] = is_array($decodedQuestions) ? $decodedQuestions : [];
        $row['answers'] = is_array($decodedAnswers) ? $decodedAnswers : [];
        unset($row['answersJson']);
        $row['passingScore'] = passingScoreForResult($pdo, ['course' => $row['course'], 'education' => $row['education']], $adminRegion);
        $results[] = $row;
    }

    if ($results === []) {
        return null;
    }

    $scores = array_map(static fn(array $result) => (int) $result['score'], $results);
    $passingScores = array_map(static fn(array $result) => (int) $result['passingScore'], $results);
    $averageScore = (int) round(array_sum($scores) / count($scores));
    $averagePassingScore = (int) round(array_sum($passingScores) / count($passingScores));
    $hasPendingEssayScore = array_reduce($results, static fn(bool $pending, array $result) => $pending || recapHasPendingEssayScore($result), false);

    return [
        'id' => rawurlencode($targetKey),
        'fullName' => (string) $results[0]['fullName'],
        'email' => (string) $results[0]['email'],
        'phone' => normalizeCandidatePhone((string) $results[0]['phone']),
        'education' => uniqueTextList(array_column($results, 'education')),
        'course' => uniqueTextList(array_column($results, 'course')),
        'score' => $averageScore,
        'passingScore' => $averagePassingScore,
        // Status menunggu review selama ada essay score yang belum diisi/masih 0; setelah itu baru dibandingkan passing grade rata-rata.
        'status' => $hasPendingEssayScore ? 'Waiting for Review' : ($averageScore >= $averagePassingScore ? 'Passed' : 'Not Passed'),
        'testCount' => count($results),
        'results' => $results,
    ];
}

function fetchActiveToken(PDO $pdo, string $adminRegion, string $adminUser): ?array
{
    $stmt = $pdo->prepare(
        'SELECT
            id,
            token,
            admin_user AS adminUser,
            region_scope AS regionScope,
            is_active AS isActive,
            expires_at AS expiresAt,
            created_at AS createdAt,
            updated_at AS updatedAt
         FROM exam_tokens
         WHERE is_active = 1
           AND region_scope = :region_scope
           AND admin_user = :admin_user
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC, id DESC
         LIMIT 1'
    );
    $stmt->execute([':region_scope' => $adminRegion, ':admin_user' => $adminUser]);

    return $stmt->fetch() ?: null;
}

try {
    $pdo = db();
    $action = (string) ($_GET['action'] ?? 'state');
    $adminRegion = adminRegionFromRequest();
    $adminUser = adminUserFromRequest();

    // Dashboard memanggil action=state untuk render tabel course, question, dan result.
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'state') {
        respond(200, ['success' => true, 'adminRegion' => $adminRegion, 'adminUser' => $adminUser] + fetchState($pdo, $adminRegion, $adminUser));
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'courses') {
        // Endpoint ringan untuk menu Course: tidak membawa result atau snapshot soal kandidat.
        respond(200, ['success' => true, 'courses' => fetchCourses($pdo, $adminRegion)]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'question_banks') {
        // List Question Bank hanya membawa metadata dan jumlah soal agar pindah menu tetap cepat.
        respond(200, ['success' => true, 'questionBanks' => fetchQuestionBanks($pdo, $adminRegion)]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'question_bank') {
        // Detail soal baru diambil saat admin membuka View/Edit Question Bank tertentu.
        $questionBankId = (int) ($_GET['id'] ?? 0);
        if ($questionBankId <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid question bank ID.']);
        }
        $questionBanks = fetchQuestionBanks($pdo, $adminRegion, true, $questionBankId);
        if ($questionBanks === []) {
            respond(404, ['success' => false, 'message' => 'Question bank was not found for this admin region.']);
        }
        respond(200, ['success' => true, 'questionBank' => $questionBanks[0]]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'results') {
        // List Results memakai server-side pagination agar semua data bisa diakses tanpa memuat semuanya sekaligus.
        $page = max(1, (int) ($_GET['page'] ?? 1));
        $pageSize = max(5, min(100, (int) ($_GET['pageSize'] ?? 50)));
        $filters = resultListFilters();
        $sortKey = cleanString($_GET['sortKey'] ?? 'date');
        $sortDirection = cleanString($_GET['sortDirection'] ?? 'desc');
        $total = fetchResultTotal($pdo, $adminRegion, $filters);
        respond(200, [
            'success' => true,
            'applications' => fetchResults($pdo, $adminRegion, false, 0, $page, $pageSize, $filters, $sortKey, $sortDirection),
            'total' => $total,
            'page' => $page,
            'pageSize' => $pageSize,
            'filterOptions' => fetchResultFilterOptions($pdo, $adminRegion),
        ]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'recapitulations') {
        // Recapitulation dihitung dari test_results existing; tidak membuat tabel baru di database production.
        $page = max(1, (int) ($_GET['page'] ?? 1));
        $pageSize = max(5, min(100, (int) ($_GET['pageSize'] ?? 50)));
        $filters = resultListFilters();
        $sortKey = cleanString($_GET['sortKey'] ?? 'name');
        $sortDirection = cleanString($_GET['sortDirection'] ?? 'asc');
        $recap = fetchRecapitulations($pdo, $adminRegion, $page, $pageSize, $filters, $sortKey, $sortDirection);
        respond(200, [
            'success' => true,
            'recapitulations' => $recap['rows'],
            'total' => $recap['total'],
            'page' => $recap['page'],
            'pageSize' => $recap['pageSize'],
            'filterOptions' => fetchResultFilterOptions($pdo, $adminRegion),
        ]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'recapitulation') {
        // Detail recap mengambil semua test result milik kandidat yang sama berdasarkan email + phone normalisasi.
        $recapId = cleanString($_GET['recapId'] ?? '');
        $recap = fetchRecapitulationDetail($pdo, $adminRegion, $recapId);
        if (!$recap) {
            respond(404, ['success' => false, 'message' => 'Recapitulation detail was not found for this admin region.']);
        }
        respond(200, ['success' => true, 'recapitulation' => $recap]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'result') {
        // Detail result dikirim hanya untuk halaman View/Review/Give Score.
        $resultId = (int) ($_GET['id'] ?? 0);
        if ($resultId <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid test result ID.']);
        }
        $results = fetchResults($pdo, $adminRegion, true, $resultId);
        if ($results === []) {
            respond(404, ['success' => false, 'message' => 'Test result was not found for this admin region.']);
        }
        respond(200, ['success' => true, 'application' => $results[0]]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'token') {
        // Token dipisah menjadi endpoint sendiri agar menu Exam Token tidak memuat tabel besar.
        respond(200, ['success' => true, 'activeToken' => fetchActiveToken($pdo, $adminRegion, $adminUser)]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        respond(405, ['success' => false, 'message' => 'Method not allowed.']);
    }

    $data = inputJson();
    $adminRegion = adminRegionFromRequest($data);
    $adminUser = adminUserFromRequest($data);

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

    if ($action === 'send_recap_email') {
        $recapId = cleanString($data['recapId'] ?? '');
        if ($recapId === '') {
            respond(422, ['success' => false, 'message' => 'Invalid recapitulation ID.']);
        }

        $recap = null;
        $page = 1;
        do {
            // Recap ID berasal dari normalisasi email+phone, jadi pencarian dilakukan dari hasil rekap read-only.
            $batch = fetchRecapitulations($pdo, $adminRegion, $page, 100);
            foreach ($batch['rows'] as $row) {
                if ((string) $row['id'] === $recapId) {
                    $recap = $row;
                    break 2;
                }
            }
            $page++;
        } while (($page - 1) * 100 < $batch['total']);

        if (!$recap) {
            respond(404, ['success' => false, 'message' => 'Recapitulation data was not found for this admin region.']);
        }

        if (($recap['status'] ?? '') !== 'Passed') {
            respond(422, ['success' => false, 'message' => 'Email can only be sent to candidates who passed the recap result.']);
        }

        $emailResult = [
            'fullName' => (string) $recap['fullName'],
            'email' => (string) $recap['email'],
            'education' => (string) $recap['education'],
            'course' => (string) $recap['course'],
        ];
        if (!sendPassedSelectionEmail($emailResult, $adminRegion)) {
            respond(500, ['success' => false, 'message' => 'Unable to send email. Please check PHP mail server configuration.']);
        }

        respond(200, [
            'success' => true,
            'message' => 'Recapitulation result email has been sent.',
        ]);
    }

    if ($action === 'update_essay_review') {
        $id = (int) ($data['id'] ?? 0);
        $reviews = is_array($data['reviews'] ?? null) ? $data['reviews'] : [];

        if ($id <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid test result ID.']);
        }

        $stmt = $pdo->prepare(
            'SELECT tr.questions_json
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

        $questions = json_decode((string) ($result['questions_json'] ?? ''), true);
        $questions = is_array($questions) ? $questions : [];
        $essayQuestions = array_values(array_filter($questions, static fn($question) => (($question['questionType'] ?? '') === 'essay')));

        if (count($essayQuestions) === 0) {
            respond(422, ['success' => false, 'message' => 'This result does not have essay answers to review.']);
        }

        // Debug backend: review essay bersifat final, jadi request kedua ditolak meski tombol frontend dimanipulasi.
        $essayAlreadyReviewed = array_reduce($essayQuestions, static fn($reviewed, $question) => $reviewed && (($question['essayReviewed'] ?? false) === true), true);
        if ($essayAlreadyReviewed) {
            respond(422, ['success' => false, 'message' => 'Essay review has already been finalized.']);
        }

        $essayPosition = 0;

        foreach ($questions as &$question) {
            if (($question['questionType'] ?? '') === 'essay') {
                $isCorrect = filter_var($reviews[(string) $essayPosition] ?? false, FILTER_VALIDATE_BOOLEAN);
                $question['essayReviewed'] = true;
                $question['isCorrect'] = $isCorrect;
                $essayPosition++;
            }
        }
        unset($question);

        $scores = questionSnapshotScores($questions);
        foreach ($questions as &$question) {
            if (($question['questionType'] ?? '') === 'essay') {
                $question['essayScore'] = $scores['essayScore'];
            }
        }
        unset($question);

        $stmt = $pdo->prepare(
            'UPDATE test_results
             SET questions_json = :questions_json,
                 updated_at = NOW()
             WHERE id = :id'
        );
        $stmt->execute([
            ':questions_json' => json_encode($questions, JSON_UNESCAPED_SLASHES),
            ':id' => $id,
        ]);

        respond(200, ['success' => true, 'message' => 'Essay review has been saved.', 'essayScore' => $scores['essayScore']]);
    }

    if ($action === 'update_weighted_score' || $action === 'update_essay_score') {
        $id = (int) ($data['id'] ?? 0);
        $multipleChoiceWeight = max(0, min(100, (int) ($data['multipleChoiceWeight'] ?? 0)));
        $essayWeight = max(0, min(100, (int) ($data['essayWeight'] ?? 0)));
        $manualEssayScore = max(0, min(100, (int) ($data['essayScore'] ?? 0)));

        if ($id <= 0) {
            respond(422, ['success' => false, 'message' => 'Invalid test result ID.']);
        }

        if (($multipleChoiceWeight + $essayWeight) !== 100) {
            respond(422, ['success' => false, 'message' => 'Total weight must be 100%.']);
        }

        $stmt = $pdo->prepare(
            'SELECT tr.questions_json
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

        $questions = json_decode((string) ($result['questions_json'] ?? ''), true);
        $questions = is_array($questions) ? $questions : [];
        $scores = questionSnapshotScores($questions);
        $essayScoreForWeight = $scores['essayTotal'] > 0 ? $manualEssayScore : 0;
        $finalScore = (int) round(($scores['mcScore'] * ($multipleChoiceWeight / 100)) + ($essayScoreForWeight * ($essayWeight / 100)));
        foreach ($questions as &$question) {
            if (($question['questionType'] ?? '') === 'essay') {
                $question['manualEssayScore'] = $manualEssayScore;
            }
            $question['weightedScoreFinalized'] = true;
            $question['weightedFinalScore'] = $finalScore;
            $question['weightedMultipleChoiceWeight'] = $multipleChoiceWeight;
            $question['weightedEssayWeight'] = $essayWeight;
        }
        unset($question);

        $stmt = $pdo->prepare(
            'UPDATE test_results
             SET score = :score,
                 questions_json = :questions_json,
                 updated_at = NOW()
             WHERE id = :id'
        );
        $stmt->execute([
            ':score' => $finalScore,
            ':questions_json' => json_encode($questions, JSON_UNESCAPED_SLASHES),
            ':id' => $id,
        ]);

        respond(200, ['success' => true, 'message' => 'Weighted score has been saved.', 'score' => $finalScore, 'essayScore' => $essayScoreForWeight]);
    }

    // Generate token 4 digit baru untuk membuka halaman selection test.
    // Token aktif dipisah per admin_user, jadi dua admin Jakarta tidak saling menonaktifkan.
    if ($action === 'generate_exam_token') {
        do {
            $token = str_pad((string) random_int(0, 9999), 4, '0', STR_PAD_LEFT);
            $stmt = $pdo->prepare(
                'SELECT COUNT(*)
                 FROM exam_tokens
                 WHERE token = :token
                   AND region_scope = :region_scope
                   AND is_active = 1
                   AND (expires_at IS NULL OR expires_at > NOW())'
            );
            $stmt->execute([':token' => $token, ':region_scope' => $adminRegion]);
        } while ((int) $stmt->fetchColumn() > 0);

        $pdo->beginTransaction();
        $stmt = $pdo->prepare('UPDATE exam_tokens SET is_active = 0 WHERE is_active = 1 AND region_scope = :region_scope AND admin_user = :admin_user');
        $stmt->execute([':region_scope' => $adminRegion, ':admin_user' => $adminUser]);
        // Token hanya berlaku sesuai EXAM_TOKEN_EXPIRES_SECONDS dan divalidasi ulang oleh backend submit_application.php.
        // Gunakan waktu MySQL, bukan waktu PHP, agar perbandingan expires_at > NOW() tidak kena beda timezone.
        $stmt = $pdo->prepare('INSERT INTO exam_tokens (token, region_scope, admin_user, is_active, expires_at, created_at) VALUES (:token, :region_scope, :admin_user, 1, DATE_ADD(NOW(), INTERVAL :expires_seconds SECOND), NOW())');
        $stmt->execute([
            ':token' => $token,
            ':region_scope' => $adminRegion,
            ':admin_user' => $adminUser,
            ':expires_seconds' => max(1, EXAM_TOKEN_EXPIRES_SECONDS),
        ]);
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
                'adminUser' => $adminUser,
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
