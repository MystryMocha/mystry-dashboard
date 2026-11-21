/** Java long-term support versions for which Eclipse Temurin provides installers. */
const TEMURIN_MAJORS = new Set([8, 11, 17, 21, 25]);
const TEMURIN_RELEASES_URL = 'https://adoptium.net/temurin/releases/';

/** Java installer download page; for a version Temurin does not provide, or an unknown version, the download page without filters. */
export function javaDownloadUrl(major: number | null | undefined): string {
  return major != null && TEMURIN_MAJORS.has(major)
    ? `${TEMURIN_RELEASES_URL}?version=${major}`
    : TEMURIN_RELEASES_URL;
}
