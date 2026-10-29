// A task link carries identity only. It is never a URL, command or file path.
export function taskIdFromHash(hash) {
    if (!hash.startsWith('#taskId=')) return null;
    const id = new URLSearchParams(hash.slice(1)).get('taskId');
    return id && id.length <= 200 && !/[\x00-\x1f\x7f/\\\uD800-\uDFFF]/.test(id) ? id : null;
}
