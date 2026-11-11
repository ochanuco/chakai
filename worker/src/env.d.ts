// secret は wrangler.jsonc に載らないので、wrangler types が作る型に入らない
interface Env {
	GITHUB_TOKEN?: string;
}

declare namespace Cloudflare {
	interface Env {
		GITHUB_TOKEN?: string;
	}
}
