import { eventTrigger, invokeTrigger } from "@trigger.dev/sdk";
import { client } from "@/trigger";
import { OpenAI } from "@trigger.dev/openai";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import { JSDOM } from "jsdom";

export const openai = new OpenAI({
  id: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
});

const processSingleUrl = client.defineJob({
  id: "process-single-url",
  name: "Process a single URL",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      url: z.string().url(),
    }),
  }),
  run: async (payload, io, ctx) => {
    const { text } = await io.runTask("get-url", async () => {
      const response = await fetch(payload.url);
      const text = await response.text();
      return { text };
    });

    const dom = new JSDOM(text);

    // We remove all the scripts and styles from the page
    dom.window.document
      .querySelectorAll("script, style")
      .forEach((el) => el.remove());

    // We grab all the titles from the page
    const content = Array.from(
      dom.window.document.querySelectorAll("h1, h2, h3, h4, h5, h6")
    );

    // We grab the last element so we can get the content between the last element and the next element
    const lastElement =
      content[content.length - 1]?.parentElement?.nextElementSibling!;
    const elements = [];

    // We loop through all the elements and grab the content between each title
    for (let i = 0; i < content.length; i++) {
      const element = content[i];
      const nextElement = content?.[i + 1] || lastElement;
      const elementsBetween = getElementsBetween(element, nextElement);
      elements.push({
        title: element.textContent,
        content: elementsBetween.map((el) => el.textContent).join("\n"),
      });
    }

    // We create a raw text format of all the content
    const page = `
        ----------------------------------
        url: ${payload.url}\n
        ${elements.map((el) => `${el.title}\n${el.content}`).join("\n")}

        ----------------------------------
        `;

    return { page };
  },
});

client.defineJob({
  id: "process-site",
  name: "Process a site",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "process.site",
    schema: z.object({
      url: z.string().url(),
    }),
  }),
  integrations: {
    openai,
  },
  concurrencyLimit: 1,
  run: async (payload, io, ctx) => {
    const sitemapUrl = `${payload.url}/sitemap.xml`;

    const sitemapUrls = await io.runTask("get-sitemap-urls", async () => {
      const response = await fetch(sitemapUrl);
      const xml = await response.text();
      const parser = new XMLParser();
      const parsed = parser.parse(xml);
      const urls = parsed.urlset.url.map((x: any) => x.loc);
      return urls as string[];
    });

    // Chunk the site map urls into groups of 25
    const chunks = [];

    for (let i = 0; i < sitemapUrls.length; i += 25) {
      chunks.push({
        index: i,
        urls: sitemapUrls.slice(i, i + 25),
      });
    }

    await io.logger.info(`Processing ${chunks.length} chunks`, { chunks });

    const pages = [];

    for (const chunk of chunks) {
      const results = await processSingleUrl.batchInvokeAndWaitForCompletion(
        `invoke-batch-${chunk.index}`,
        chunk.urls.map((url) => ({ payload: { url } }))
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const url = chunk.urls[i];

        if (result.ok) {
          pages.push({
            url,
            page: result.output.page,
          });
        }
      }
    }

    await io.logger.info(`Processed ${pages.length} pages`, {
      page1: pages[0],
    });

    const fileContents = pages.map((page) => page.page).join("\n\n");

    const file = await io.openai.files.createAndWaitForProcessing(
      "upload-file",
      {
        purpose: "assistants",
        file: fileContents,
      }
    );

    const assistant = await io.store.env.get<{ id: string }>(
      "get-assistant",
      payload.url
    );

    if (!assistant) {
      // Create a new assistant
      const { id } = await io.openai.beta.assistants.create(
        "create-assistant",
        {
          name: `assistant for ${payload.url}`,
          description: "Documentation",
          instructions:
            "You are a documentation assistant, you have been loaded with documentation from " +
            payload.url +
            ", return everything in an markdown format.",
          model: "gpt-4-1106-preview",
          tools: [{ type: "code_interpreter" }, { type: "retrieval" }],
          file_ids: [file.id],
        }
      );

      await io.store.env.set("set-assistant", payload.url, { id });

      return { id };
    } else {
      await io.openai.beta.assistants.update("update-assistant", assistant.id, {
        file_ids: [file.id],
      });

      return { id: assistant.id };
    }
  },
});

function getElementsBetween(startElement: Element, endElement: Element) {
  let currentElement = startElement;
  const elements = [];

  // Traverse the DOM until the endElement is reached
  while (currentElement && currentElement !== endElement) {
    currentElement = currentElement.nextElementSibling!;

    // If there's no next sibling, go up a level and continue
    if (!currentElement) {
      // @ts-ignore
      currentElement = startElement.parentNode!;
      startElement = currentElement;
      if (currentElement === endElement) break;
      continue;
    }

    // Add the current element to the list
    if (currentElement && currentElement !== endElement) {
      elements.push(currentElement);
    }
  }

  return elements;
}

client.defineJob({
  id: "delete-assistant",
  name: "Delete Assistant",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      id: z.string(),
    }),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    await io.openai.beta.assistants.del("delete", payload.id);
  },
});

client.defineJob({
  id: "question-assistant",
  name: "Question Assistant",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      content: z.string(),
      url: z.string(),
      threadId: z.string().optional(),
    }),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    const assistant = await io.store.env.get<{ id: string }>(
      "get-assistant",
      payload.url
    );

    if (!assistant) {
      throw new Error(`No assistant found for ${payload.url}`);
    }

    // Create or use an existing thread
    const thread = payload.threadId
      ? await io.openai.beta.threads.retrieve("get-thread", payload.threadId)
      : await io.openai.beta.threads.create("create-thread");

    // Create a message in the threadimpo
    await io.openai.beta.threads.messages.create("create-message", thread.id, {
      content: payload.content,
      role: "user",
    });

    // Run the thread
    const run = await io.openai.beta.threads.runs.createAndWaitForCompletion(
      "run-thread",
      thread.id,
      {
        model: "gpt-4-1106-preview",
        assistant_id: assistant.id,
      }
    );

    // Check the status of the thread
    if (run.status !== "completed") {
      throw new Error(
        `Run finished with status ${run.status}: ${JSON.stringify(
          run.last_error
        )}`
      );
    }

    // Get the messages from the thread
    const messages = await io.openai.beta.threads.messages.list(
      "list-messages",
      run.thread_id,
      {
        limit: 10,
        order: "desc",
      }
    );

    return messages;
  },
});
