// supabase/functions/scrape-tripadvisor-reviews/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { DOMParser, Element } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
import { chromium, Browser as PlaywrightBrowser, Page as PlaywrightPage } from "npm:playwright-core";
import { Browserbase } from "npm:@browserbasehq/sdk";

interface Review {
  reviewer_name: string | null;
  reviewer_profile: string | null;
  avatar_url: string | null;
  contributions: string | null;
  helpful_votes: string | null;
  rating: number | null;
  review_title: string | null;
  review_date: string | null;
  trip_type: string | null;
  review_text: string | null;
  review_of: string | null;
  review_of_link: string | null;
  written_date: string | null;
  disclaimer: string | null;
  unique_id?: string;
  source_url?: string;
  scraped_at?: string;
}

const TRIPADVISOR_BASE_URL = "https://www.tripadvisor.com";

function getText(element: Element | null, selector: string, strip = true): string | null {
  const selected = element?.querySelector(selector);
  if (selected) {
    let text = selected.textContent;
    if (strip) {
      text = text?.trim();
    }
    return text || null;
  }
  return null;
}

function getAttr(element: Element | null, selector: string, attribute: string): string | null {
  const selected = element?.querySelector(selector);
  return selected?.getAttribute(attribute) || null;
}

async function scrapeSinglePage(page: PlaywrightPage, sourceUrl: string): Promise<Review[]> {
  console.log(`Processing page content for URL: ${sourceUrl}`);
  let html = "";
  try {
    await page.waitForSelector('div[data-automation="reviewCard"]', { timeout: 60000 });
    console.log("Review cards detected. Extracting page content...");
    html = await page.content();
    console.log(`Page content extracted for ${sourceUrl}. HTML length: ${html.length}`);
  } catch (e) {
    console.error(`Playwright error while waiting/extracting content for ${sourceUrl}:`, e.message, e.stack);
    return [];
  }

  if (!html) {
    console.log(`No HTML content was retrieved for ${sourceUrl}.`);
    return [];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) {
    console.error(`Failed to parse HTML document with deno-dom for ${sourceUrl}.`);
    return [];
  }

  const reviewCards = doc.querySelectorAll('div[data-automation="reviewCard"]');
  const reviews: Review[] = [];
  console.log(`Found ${reviewCards.length} review cards in the parsed HTML for ${sourceUrl}.`);

  for (const card of reviewCards) {
    const cardElement = card as Element;
    const review: Partial<Review> = {};

    const reviewerTagElement = cardElement.querySelector("div.QIHsu.Zb a, span.JAZVu.sVnOO > a");
    if (reviewerTagElement) {
      review.reviewer_name = reviewerTagElement.textContent.trim();
      const href = reviewerTagElement.getAttribute("href");
      review.reviewer_profile = href ? (href.startsWith("/") ? `${TRIPADVISOR_BASE_URL}${href}` : href) : null;
    } else {
      review.reviewer_name = getText(cardElement, "span[class^='ui_header_name']");
      review.reviewer_profile = null;
    }

    review.avatar_url = getAttr(cardElement, "img[src]", "src");
    review.contributions = getText(cardElement, "div.vYLts span, span.biGQs.fSPVG");

    const helpfulButton = cardElement.querySelector('button[aria-label*="helpful vote"]');
    if (helpfulButton) {
      review.helpful_votes = getText(helpfulButton as Element, "span[class*='biGQs']");
    } else {
      review.helpful_votes = null;
    }

    const ratingSvg = cardElement.querySelector("svg[class*='UctUV']");
    if (ratingSvg) {
      const ratingText = getText(ratingSvg as Element, "title");
      if (ratingText) {
        const match = ratingText.match(/([\d\.]+) of/);
        review.rating = match && match[1] ? parseFloat(match[1]) : null;
      } else {
        review.rating = null;
      }
    } else {
      review.rating = null;
    }

    review.review_title = getText(cardElement, "div.biGQs._P.fiohW.qWPrE.ncFvv.fOtGX span.yCeTE, div.QZdOXhEy > span");

    const tripInfoText = getText(cardElement, "div.RpeCd, div.RpeCd span.teHYY._R.Me.Z.bToff");
    if (tripInfoText) {
      const parts = tripInfoText.split("•").map(p => p.trim());
      review.review_date = parts[0] || null;
      review.trip_type = parts.length > 1 ? parts[1] : null;
    } else {
      review.review_date = null;
      review.trip_type = null;
    }

    let fullText = getText(cardElement, "div.fIrGe._T.bgMZj span.yCeTE, span.QewHA.H4._a");
    if (fullText) {
      review.review_text = fullText.replaceAll(/\s+/g, ' ').trim();
    } else {
      review.review_text = null;
    }

    const reviewOfTagElement = cardElement.querySelector("div.biGQs._P.pZUbB.xUqsL.mowmC.KxBGd a, div.yPOCb > div > div > a");
    if (reviewOfTagElement) {
      review.review_of = reviewOfTagElement.textContent.trim();
      const href = reviewOfTagElement.getAttribute("href");
      review.review_of_link = href ? (href.startsWith("/") ? `${TRIPADVISOR_BASE_URL}${href}` : href) : null;
    } else {
      review.review_of = null;
      review.review_of_link = null;
    }

    const treSq = cardElement.querySelector("div.TreSq");
    if (treSq) {
      const infoDivs = treSq.querySelectorAll("div[class*='biGQs'][class*='pZUbB']");
      review.written_date = infoDivs.length > 0 ? infoDivs[0].textContent.trim() : null;
      review.disclaimer = infoDivs.length > 1 ? infoDivs[1].textContent.trim() : null;
    } else {
      const writtenDateFallbackText = getText(cardElement, "span.teHYY._R.Me.Z.bToff");
      if (writtenDateFallbackText && writtenDateFallbackText.match(/Reviewed |Written /i)) {
        review.written_date = writtenDateFallbackText.replace(/Reviewed |Written /i, '').trim();
      } else {
        review.written_date = null;
      }
      review.disclaimer = null;
    }

    if (review.reviewer_name && review.written_date) {
      review.unique_id = `${review.reviewer_name}_${review.written_date}`.replace(/\s+/g, '_').toLowerCase();
    } else {
      console.warn("Missing reviewer_name or written_date for unique_id generation for a review on:", sourceUrl);
    }

    review.source_url = sourceUrl;
    review.scraped_at = new Date().toISOString();

    reviews.push(review as Review);
  }
  return reviews;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
      },
    });
  }

  const browserbaseApiKey = Deno.env.get("BROWSERBASE_API_KEY");
  const browserbaseProjectId = Deno.env.get("BROWSERBASE_PROJECT_ID");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "Supabase URL or Anon Key not provided." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  if (!browserbaseApiKey || !browserbaseProjectId) {
    return new Response(JSON.stringify({ error: "Browserbase API Key or Project ID not provided." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const bb = new Browserbase({ apiKey: browserbaseApiKey });
  let playwrightBrowser: PlaywrightBrowser | null = null;
  let bbSession: any = null; 
  let page: PlaywrightPage | null = null;

  try {
    console.log("Creating Browserbase session for the entire run...");
    bbSession = await bb.sessions.create({ projectId: browserbaseProjectId, region: "us-east-1", proxies: true });
    console.log(`Browserbase session created. Connect URL: ${bbSession.connectUrl ? 'exists' : 'missing'}`);

    playwrightBrowser = await chromium.connectOverCDP(bbSession.connectUrl, { timeout: 60000 });
    console.log("Connected to Playwright browser over CDP for the entire run.");
    
    const context = playwrightBrowser.contexts()[0];
    page = context.pages()[0];
    console.log("Playwright page created for scraping.");

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      }
    });

    const attractionId = "d9769852";
    const cityId = "g60763";
    const attractionName = "Manhattan_Mark_Tours";
    const cityName = "New_York_City_New_York";
    const baseUrlTemplate = `https://www.tripadvisor.com/Attraction_Review-${cityId}-${attractionId}-Reviews-{PAGINATION_TOKEN}-${attractionName}-${cityName}.html`;

    let allScrapedReviews: Review[] = [];
    let skip = 0;
    let pageNum = 0;
    const MAX_PAGES = 5; 

    console.log(`Starting TripAdvisor review scraping process for ${MAX_PAGES} pages.`);

    while (pageNum < MAX_PAGES) {
      const paginationToken = skip === 0 ? "" : `or${skip}`;
      const currentUrl = baseUrlTemplate.replace("{PAGINATION_TOKEN}", paginationToken);

      console.log(`Navigating to ${currentUrl} (Page ${pageNum + 1}/${MAX_PAGES})...`);
      await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
      console.log(`Navigation to ${currentUrl} complete.`);

      const reviewsOnPage = await scrapeSinglePage(page, currentUrl);

      if (reviewsOnPage.length === 0 && pageNum > 0) { // If not the first page and no reviews, might be the end
        console.log(`No reviews found on page ${pageNum + 1} (offset ${skip}). Assuming end of reviews or issue.`);
        break; 
      }
      if (reviewsOnPage.length === 0 && pageNum === 0) { // If first page has no reviews, something is wrong
        console.warn(`No reviews found on the first page (${currentUrl}). Check selectors or website structure.`);
        // Potentially break or continue cautiously if you expect this sometimes
      }


      allScrapedReviews = allScrapedReviews.concat(reviewsOnPage);
      const reviewsActuallyScrapedThisPage = reviewsOnPage.length;
      skip += reviewsActuallyScrapedThisPage;
      pageNum++;

      console.log(`Scraped ${reviewsActuallyScrapedThisPage} reviews from ${currentUrl}. Total scraped: ${allScrapedReviews.length}. Next skip offset: ${skip}`);

      if (pageNum < MAX_PAGES && reviewsActuallyScrapedThisPage > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`Scraping finished. Total reviews collected: ${allScrapedReviews.length}`);

    if (allScrapedReviews.length === 0) {
      return new Response(JSON.stringify({ message: "No reviews found or scraping failed overall.", details: "No reviews were collected from TripAdvisor." }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, status: 200,
      });
    }

    const reviewsToUpsert = allScrapedReviews.filter(r => r.unique_id);
    const reviewsWithoutIdCount = allScrapedReviews.length - reviewsToUpsert.length;
    if (reviewsWithoutIdCount > 0) {
      console.warn(`${reviewsWithoutIdCount} reviews were missing essential data for a unique ID and will be skipped.`);
    }

    if (reviewsToUpsert.length === 0) {
      return new Response(JSON.stringify({ message: "No reviews with valid unique identifiers to process." }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, status: 200,
      });
    }

    console.log(`Attempting to process ${reviewsToUpsert.length} reviews into Supabase.`);
    const { data: upsertData, error: upsertError } = await supabase
      .from("reviews")
      .upsert(reviewsToUpsert, {
        onConflict: "unique_id",
        ignoreDuplicates: true,
      })
      .select();

    if (upsertError) {
      console.error("Supabase upsert error:", upsertError);
      throw upsertError; // This will be caught by the outer catch
    }

    console.log("Supabase processing successful. Records processed count (may include ignored duplicates):", upsertData?.length || 0);
    return new Response(JSON.stringify({
      message: "Scraping and Supabase processing completed.",
      scrapedCount: allScrapedReviews.length,
      processedForUpsertCount: reviewsToUpsert.length,
      supabaseResultCount: upsertData?.length || 0,
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, status: 200 });

  } catch (err) {
    console.error("Error in Edge Function main handler:", err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message || "An unexpected error occurred." }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } finally {
    if (playwrightBrowser) {
      console.log("Closing Playwright browser connection at the end of the run...");
      await playwrightBrowser.close().catch(err => console.error("Error closing Playwright browser in finally block:", err));
    }
    console.log("Edge function execution finished.");
  }
});