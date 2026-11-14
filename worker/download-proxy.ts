// worker/download-proxy.ts
//
// Golia 更新下载的 Cloudflare Worker 代理（lx10，第 5 项的 CF 备选）。
//
// 它把 GitHub Release 的 IPA 下载地址代理出来：App 点“去下载”时先走 gh-proxy.org，
// 加速失败回落 GitHub 直连；这个 Worker 是第三条路——自己部署的加速节点，
// 下载地址是 `https://<worker>.workers.dev/<tag>/<file>`，例如：
//   https://golia-download.<account>.workers.dev/v0.7.28-lx10/Folia_0.7.28-lx10.ipa
// 只代理 Rxsume/Golia 仓库的 .ipa 文件，别的一律 404（不是开放代理）。
//
// 部署步骤（不要在没有 Cloudflare 凭证的机器上跑；部署由维护者或用户之后再定）：
//   1. `npx wrangler deploy --name golia-download-proxy worker/download-proxy.ts`
//      （单文件 Worker，不需要 wrangler.jsonc，名字自定；不需要任何 secret。）
//   2. 部署成功后，把 App 里 `src/services/appUpdate/appUpdateCheck.ts` 的
//      `APP_UPDATE_ACCELERATOR_BASE_URL` 改成 `https://<部署出的域名>/`，重新出包。
//      不改就继续走 gh-proxy.org，这个 Worker 只是备用。
//   3. 验证：`curl -I https://<域名>/v0.7.28-lx9/Folia_0.7.28-lx9.ipa`
//      应回 200 + `content-type: application/octet-stream` +
//      `content-disposition: attachment; filename="Folia_0.7.28-lx9.ipa"`。
//
// iOS 硬限制（不要对它有别的期待）：这个 Worker 只解决“下载地址快不快、稳不稳”，
// App 拿到文件后仍然要用户自己用全能签重签安装——iOS 上 App 装不了未签名的 IPA，
// 也替换不了自己。壳里也没有 Filesystem 插件（lx10 查过：packageClassList 只有
// Browser/SplashScreen/StatusBar），所以“App 内直接存进 Files”做不到；
// 现在的接法是 App 内点更新 → 加速地址 → 交给系统浏览器保存文件。

/** Only this repo is proxied; anything else is not our release. */
const REPO_OWNER = 'Rxsume';
const REPO_NAME = 'Golia';

/** A release tag we serve: `v0.7.28-lx10` and the like. */
const TAG_PATTERN = /^v\d+\.\d+\.\d+-lx\d+$/;

/** A release asset we serve: the IPA file of that build. */
const FILE_PATTERN = /^Folia_0\.7\.28-lx\d+\.ipa$/;

/** The IPA never changes under a tag, so the edge may keep it for an hour. */
const CACHE_TTL_SECONDS = 3600;

/** Only the Cloudflare fetch options this proxy uses; the repo has no `@cloudflare/workers-types`. */
type CfRequestInit = RequestInit & {
    cf?: {
        cacheTtl?: number;
        cacheEverything?: boolean;
    };
};

const jsonError = (status: number, message: string): Response => (
    new Response(JSON.stringify({ code: status, message }), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    })
);

export default {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        // `/v0.7.28-lx10/Folia_0.7.28-lx10.ipa` — nothing else.
        const [, tag, file] = url.pathname.split('/');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return jsonError(405, 'Method not allowed');
        }
        if (!tag || !file || !TAG_PATTERN.test(tag) || !FILE_PATTERN.test(file)) {
            return jsonError(404, 'Not found');
        }

        const upstream = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${tag}/${file}`;
        let response: Response;
        try {
            // fetch follows GitHub's 302 to release-assets.githubusercontent.com on its own.
            const init: CfRequestInit = {
                method: request.method,
                headers: { 'user-agent': 'golia-download-proxy/1.0' },
                cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
            };
            response = await fetch(upstream, init);
        } catch (error) {
            console.error('[download-proxy] upstream fetch failed:', error);
            return jsonError(502, 'Upstream fetch failed');
        }
        if (!response.ok) {
            return jsonError(response.status, `Upstream answered ${response.status}`);
        }

        // The file, with the headers a download needs: a binary type, a filename the
        // system browser saves under, and an open CORS so the app can HEAD-check it.
        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/octet-stream');
        headers.set('content-disposition', `attachment; filename="${file}"`);
        headers.set('access-control-allow-origin', '*');
        headers.set('cache-control', `public, max-age=${CACHE_TTL_SECONDS}`);
        return new Response(response.body, {
            status: response.status,
            headers,
        });
    },
};
