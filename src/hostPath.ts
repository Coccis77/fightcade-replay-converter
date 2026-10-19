// fc2mp4-docker mounts the user's videos folder at /videos and tells fc2mp4 where it really is
// (FC2MP4_HOST_VIDEOS): messages and the printed video path then show the user's own folder.
export function hostPath(text: string, env: Record<string, string | undefined> = process.env): string {
  const host = env.FC2MP4_HOST_VIDEOS;
  if (!host) return text;
  return text.replace(/(^|[\s"'(:])\/videos(?=\/|$|[\s"')])/g, (_match, before: string) => before + host);
}
