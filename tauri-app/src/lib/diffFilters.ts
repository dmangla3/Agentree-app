import { DiffResult, FileDiff } from './agentClient';

export const IGNORED_EXTENSIONS = new Set([
    // Python
    'pyc', 'pyo', 'pyd',
    // Compiled/Binary
    'so', 'o', 'obj', 'dll', 'exe', 'dylib',
    // Java
    'class', 'jar', 'war', 'ear',
    // Archives
    'zip', 'tar', 'gz', '7z', 'rar',
    // macOS
    'DS_Store',
    // Fonts
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    // Images
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp',
    // Documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
]);

export const IGNORED_PATTERNS = [
    '__pycache__',
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    'coverage',
    '.codex',
    '.claude',
    // Python
    '__pycache__',
    '.venv',
    'venv',
    'env',
    '.pytest_cache',
    '.mypy_cache',
    // Common
    'bin',
    'obj',
];

export const DEFAULT_IGNORE_PATTERNS = IGNORED_PATTERNS;

export function shouldIgnoreFile(path: string): boolean {
    // Check extension
    const parts = path.split('.');
    if (parts.length > 1) {
        const ext = parts[parts.length - 1].toLowerCase();
        if (IGNORED_EXTENSIONS.has(ext)) {
            return true;
        }
    }

    // Check patterns (directories or filenames)
    // We check if any segment of the path matches an ignored pattern
    const segments = path.split('/');
    for (const segment of segments) {
        if (IGNORED_PATTERNS.includes(segment)) {
            return true;
        }
        if (segment.endsWith('.egg-info')) {
            return true;
        }
    }

    return false;
}

export function filterDiffResult(result: DiffResult): DiffResult {
    if (!result || !result.files) {
        return result;
    }

    const filteredFiles = result.files.filter((file: FileDiff) => !shouldIgnoreFile(file.path));

    // Recalculate stats based on filtered files
    const stats = {
        files_added: 0,
        files_modified: 0,
        files_deleted: 0,
        total_additions: 0,
        total_deletions: 0,
    };

    filteredFiles.forEach((file: FileDiff) => {
        if (file.status === 'added') stats.files_added++;
        else if (file.status === 'modified') stats.files_modified++;
        else if (file.status === 'deleted') stats.files_deleted++;

        stats.total_additions += file.additions;
        stats.total_deletions += file.deletions;
    });

    return {
        ...result,
        files: filteredFiles,
        stats,
    };
}
