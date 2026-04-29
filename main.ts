import {
  DOMParser,
  Element,
} from "https://deno.land/x/deno_dom@v0.1.35-alpha/deno-dom-wasm.ts";
import { database, Question } from "./database.ts";
import {
  parseContentsFromDocument,
  parseQuestionFromRawContent,
} from "./parser.ts";
import { generateReport, throttle } from "./utils.ts";

export const CRAWLERS = {
  RC: `https://gmatclub.com/forum/search.php?selected_search_tags%5B%5D=162&selected_search_tags%5B%5D=228&selected_search_tags%5B%5D=229&t=0&search_tags=exact&submit=Search`,
  SC: `https://gmatclub.com/forum/search.php?selected_search_tags%5B%5D=172&selected_search_tags%5B%5D=231&selected_search_tags%5B%5D=232&t=0&search_tags=exact&submit=Search`,
  CR: `https://gmatclub.com/forum/search.php?selected_search_tags%5B%5D=168&selected_search_tags%5B%5D=226&selected_search_tags%5B%5D=227&t=0&search_tags=exact&submit=Search`,
  PS: `https://gmatclub.com/forum/search.php?selected_search_tags%5B%5D=187&selected_search_tags%5B%5D=216&selected_search_tags%5B%5D=217&t=0&search_tags=exact&submit=Search`,
  DS: `https://gmatclub.com/forum/search.php?selected_search_tags%5B%5D=180&selected_search_tags%5B%5D=222&selected_search_tags%5B%5D=223&t=0&search_tags=exact&submit=Search`,
};

const CHROME_CANDIDATES = [
  "google-chrome",
  "chromium-browser",
  "chromium",
  "chrome",
];

function getIdFromUrl(url: string) {
  if (url.endsWith(".html")) {
    url = url.slice(0, -5);
  }
  const parts = url.split("-");
  return parts[parts.length - 1];
}

function isChallengePage(text: string) {
  return text.includes("Just a moment...") ||
    text.includes("Enable JavaScript and cookies to continue");
}

async function findChromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      const command = new Deno.Command(candidate, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      });
      const { code } = await command.output();
      if (code === 0) {
        return candidate;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
  return null;
}

async function fetchHtmlWithBrowser(url: string) {
  const chrome = await findChromeBinary();
  if (!chrome) {
    return null;
  }

  console.warn(`>>> Falling back to ${chrome} for ${url}`);
  const command = new Deno.Command(chrome, {
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=15000",
      "--dump-dom",
      url,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `${chrome} failed for ${url}: ${new TextDecoder().decode(stderr)}`
    );
  }

  return new TextDecoder().decode(stdout);
}

async function fetchAsDOM(url: string) {
  let text: string | null = null;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
    });
    const challenge = res.headers.get("cf-mitigated");
    text = await res.text();
    if (!res.ok || challenge === "challenge" || isChallengePage(text)) {
      text = await fetchHtmlWithBrowser(url);
    }
  } catch {
    text = await fetchHtmlWithBrowser(url);
  }

  if (!text || isChallengePage(text)) {
    throw new Error(`GMAT Club returned an anti-bot challenge for ${url}`);
  }

  const document = new DOMParser().parseFromString(text, "text/html");
  if (!document) {
    throw new Error(`Unable to parse HTML returned by ${url}`);
  }
  return document!;
}

async function crawlQuestion(
  url: string,
  type: keyof typeof CRAWLERS
): Promise<Question> {
  console.warn(">>> Crawling question", url);
  const id = getIdFromUrl(url);
  const document = await fetchAsDOM(url);
  const contents = parseContentsFromDocument(document);
  const [rawQuestion, ...explanations] = contents.slice(0, -1);
  const question = parseQuestionFromRawContent(rawQuestion, type);
  return {
    id,
    src: url,
    explanations,
    ...question,
  };
}

async function crawl() {
  await Deno.mkdir("./output", { recursive: true });
  for (const key in CRAWLERS) {
    const questionType = key as keyof typeof CRAWLERS;
    const url = database[questionType].length
      ? `${CRAWLERS[questionType]}&start=${database[questionType].length}`
      : CRAWLERS[questionType];
    console.warn(">>> Crawling ", questionType, url);
    const document = await fetchAsDOM(url);
    const posts = Array.from(document.querySelectorAll(".topic-link")).map(
      (title) => {
        const el = title as Element;
        return {
          title: el.getAttribute("title"),
          href: el.getAttribute("href"),
        };
      }
    );
    if (!posts.length) {
      throw new Error(
        `No question links were found for ${questionType}. The crawler likely received an unexpected GMAT Club response.`
      );
    }
    for (const post of posts) {
      const questionUrl = post.href!;
      const id = getIdFromUrl(questionUrl);
      if (!database[questionType].includes(id)) {
        try {
          await throttle();
          const question = await crawlQuestion(questionUrl, questionType);
          database[questionType].push(id);
          await Deno.writeTextFile(
            `./output/${id}.json`,
            JSON.stringify(question)
          );
          await Deno.writeTextFile(
            "./output/index.json",
            JSON.stringify(database)
          );
        } catch (error) {
          console.warn(
            `>>> Error while parsing question #${id}, skipping...`,
            error
          );
        }
      } else {
        console.warn(`>>> Question #${id} already crawln, skipping...`);
      }
    }
  }
}

await crawl();
generateReport();
