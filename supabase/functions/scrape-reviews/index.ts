// supabase/functions/scrape-tripadvisor-reviews/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { DOMParser, Element } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
import { chromium, Browser as PlaywrightBrowser } from "npm:playwright-core"; // Renamed Browser to PlaywrightBrowser to avoid conflict
import { Browserbase } from "npm:@browserbasehq/sdk";

// Define the structure of a review
interface Review {
  reviewer_name: string | null;
  reviewer_profile: string | null;
  avatar_url: string | null;
  contributions: string | null;
  helpful_votes: string | null;
  rating: number | null;
  review_title: string | null;
  review_date: string | null; // Date of the trip
  trip_type: string | null;
  review_text: string | null;
  review_of: string | null;
  review_of_link: string | null;
  written_date: string | null; // Date the review was written
  disclaimer: string | null;
  unique_id?: string; // For Supabase upsert: reviewer_name + written_date
  source_url?: string; // To store the URL from which it was scraped
  scraped_at?: string; // Timestamp of when it was scraped
}

const TRIPADVISOR_BASE_URL = "https://www.tripadvisor.com";

// Helper to safely get text content from a specific element
function getText(element: Element | null, selector: string, strip = true): string | null {
  const selected = element?.querySelector(selector);
  if (selected) {
    let text = selected.textContent;
    if (strip) {
      text = text?.trim();
    }
    return text || null; // Ensure empty string becomes null
  }
  return null;
}

// Helper to safely get an attribute from a specific element
function getAttr(element: Element | null, selector: string, attribute: string): string | null {
  const selected = element?.querySelector(selector);
  return selected?.getAttribute(attribute) || null; // Ensure empty attribute becomes null
}

async function scrapeSinglePage(url: string): Promise<Review[]> {
  console.log(`Attempting to scrape URL with Browserbase/Playwright: ${url}`);

  const browserbaseApiKey = Deno.env.get("BROWSERBASE_API_KEY");
  const browserbaseProjectId = Deno.env.get("BROWSERBASE_PROJECT_ID");

  if (!browserbaseApiKey || !browserbaseProjectId) {
    console.error("Browserbase API Key or Project ID is not set in environment variables.");
    return [];
  }

  const bb = new Browserbase({ apiKey: browserbaseApiKey });
  let playwrightBrowser: PlaywrightBrowser | null = null;
  let bbSession: any = null;

  let html = "";

  try {
    console.log("Creating Browserbase session...");
    bbSession = await bb.sessions.create({ projectId: browserbaseProjectId, region: "us-east-1", proxies: true }); 
    console.log(`Browserbase session created. Connect URL: ${bbSession.connectUrl ? 'exists' : 'missing'}`);

    playwrightBrowser = await chromium.connectOverCDP(bbSession.connectUrl, { timeout: 60000 }); 
    console.log("Connected to Playwright browser over CDP.");

    const context = playwrightBrowser.contexts()[0];
    const page = context.pages()[0];
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }); 
    console.log("Navigation complete. Waiting for review cards...");

    await page.waitForSelector('div[data-automation="reviewCard"]', { timeout: 60000 }); 
    console.log("Review cards detected. Extracting page content...");

    html = await page.content();
    console.log(`Page content extracted. HTML length: ${html.length}`);

  } catch (e) {
    console.error(`Playwright/Browserbase error while scraping ${url}:`, e.message, e.stack);
    return []; 
  } finally {
    if (playwrightBrowser) {
      console.log("Closing Playwright browser connection...");
      await playwrightBrowser.close().catch(err => console.error("Error closing Playwright browser:", err));
    }
    console.log("Scraping for single page finished (or errored).");
  }

  if (!html) {
    console.log("No HTML content was retrieved.");
    return [];
  }
  
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) {
      console.error("Failed to parse HTML document with deno-dom.");
      return [];
  }

  const reviewCards = doc.querySelectorAll('div[data-automation="reviewCard"]');
  const reviews: Review[] = [];
  console.log(`Found ${reviewCards.length} review cards in the parsed HTML.`);

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
      console.warn("Missing reviewer_name or written_date for unique_id generation for a review on:", url);
    }

    review.source_url = url;
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

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("Supabase URL or Anon Key not provided in environment variables.");
    }
    if (!Deno.env.get("BROWSERBASE_API_KEY") || !Deno.env.get("BROWSERBASE_PROJECT_ID")) {
        console.error("Browserbase API Key or Project ID is not set. Scraping will fail.");
    }


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
    const MAX_PAGES = 100; 

    console.log("Starting TripAdvisor review scraping process...");

    while (pageNum < MAX_PAGES) {
      const paginationToken = skip === 0 ? "" : `or${skip}`;
      const currentUrl = baseUrlTemplate.replace("{PAGINATION_TOKEN}", paginationToken);
      
      const reviewsOnPage = await scrapeSinglePage(currentUrl);

      if (reviewsOnPage.length === 0) {
        console.log(`No more reviews found or scraping failed for page ${pageNum +1} (offset ${skip}). Stopping.`);
        break;
      }

      allScrapedReviews = allScrapedReviews.concat(reviewsOnPage);

      const reviewsActuallyScrapedThisPage = reviewsOnPage.length;
      skip += reviewsActuallyScrapedThisPage;

      pageNum++;
      console.log(`Scraped ${reviewsActuallyScrapedThisPage} reviews from page ${pageNum}. Total scraped: ${allScrapedReviews.length}. Next skip offset: ${skip}`);
      
      if (pageNum < MAX_PAGES && reviewsActuallyScrapedThisPage > 0) {
         await new Promise(resolve => setTimeout(resolve, 500)); 
      }
    }

    console.log(`Scraping finished. Total reviews collected: ${allScrapedReviews.length}`);

    if (allScrapedReviews.length === 0) {
      return new Response(JSON.stringify({ message: "No new reviews found or scraping failed.", details: "No reviews were collected from TripAdvisor." }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        status: 200,
      });
    }
    
    const reviewsToUpsert = allScrapedReviews.filter(r => r.unique_id);
    const reviewsWithoutIdCount = allScrapedReviews.length - reviewsToUpsert.length;
    if (reviewsWithoutIdCount > 0) {
        console.warn(`${reviewsWithoutIdCount} reviews were missing essential data for a unique ID and will be skipped.`);
    }

    if (reviewsToUpsert.length === 0) {
      return new Response(JSON.stringify({ message: "No reviews with valid unique identifiers to process." }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        status: 200,
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
      throw upsertError;
    }

    console.log("Supabase processing successful. Records processed count (may include ignored duplicates):", upsertData?.length || 0);

    return new Response(
      JSON.stringify({
        message: "Scraping and Supabase processing completed.",
        scrapedCount: allScrapedReviews.length,
        processedForUpsertCount: reviewsToUpsert.length,
        supabaseResultCount: upsertData?.length || 0,
      }),
      {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        status: 200,
      }
    );

  } catch (err) {
    console.error("Error in Edge Function:", err.message, err.stack);
    return new Response(String(err?.message ?? err), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});