/** Eclipse Temurin 提供安装包的 Java 长期支持版本。 */
const TEMURIN_MAJORS = new Set([8, 11, 17, 21, 25]);
const TEMURIN_RELEASES_URL = 'https://adoptium.net/temurin/releases/';

/** Java 安装包下载页；不是 Temurin 提供的版本或版本未知时给出不带筛选的下载页。 */
export function javaDownloadUrl(major: number | null | undefined): string {
  return major != null && TEMURIN_MAJORS.has(major)
    ? `${TEMURIN_RELEASES_URL}?version=${major}`
    : TEMURIN_RELEASES_URL;
}
