
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { Recipe, PriceSearchResult, UserProfile, ShoppingCategory } from "../types";

// --- Configuration ---
const MODEL_TEXT_SEARCH = "gemini-2.5-flash";
const MODEL_VISION_NANO = "gemini-2.5-flash-image"; // For analyzing fridge & generating dish image
const MODEL_TTS = "gemini-2.5-flash-preview-tts";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Helpers ---

/**
 * Exponential backoff retry wrapper for API calls.
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && (error.status === 429 || error.status === 503 || error.message?.includes('429'))) {
      console.warn(`Rate limited. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(res => setTimeout(res, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

// --- API Functions ---

/**
 * Analyzes a fridge photo to detect ingredients using Nano Banana model.
 */
export async function analyzeFridgeImage(base64Image: string, mimeType: string): Promise<string[]> {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: MODEL_VISION_NANO,
      contents: {
        parts: [
          {
            inlineData: {
              data: base64Image,
              mimeType: mimeType,
            },
          },
          {
            text: "Identify the food ingredients visible in this fridge/pantry photo. Return ONLY a JSON array of strings, e.g. ['eggs', 'milk', 'carrots']. Do not include markdown formatting.",
          },
        ],
      },
    });

    const text = response.text || "[]";
    // Clean up potential markdown code blocks if the model disobeys "no markdown"
    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    
    try {
      return JSON.parse(cleanText);
    } catch (e) {
      console.error("Failed to parse ingredients JSON", text);
      return text.split(',').map(s => s.trim()); // Fallback
    }
  });
}

/**
 * Generates a structured recipe based on ingredients and user profile.
 */
export async function generateRecipe(ingredients: string[], profile: UserProfile): Promise<Recipe> {
  return withRetry(async () => {
    let profileContext = "";
    if (profile.dietaryRestrictions.length > 0) {
      profileContext += `Dietary Restrictions: ${profile.dietaryRestrictions.join(", ")}. `;
    }
    if (profile.allergies.length > 0) {
      profileContext += `AVOID these Allergens: ${profile.allergies.join(", ")}. `;
    }
    if (profile.cuisinePreferences.length > 0) {
      profileContext += `Preferred Cuisines: ${profile.cuisinePreferences.join(", ")}. `;
    }
    
    // Combine detected ingredients with custom profile ingredients
    const allIngredients = [...ingredients, ...profile.customIngredients];

    const prompt = `Create a delicious recipe using some or all of these ingredients: ${allIngredients.join(", ")}. 
    You may assume common pantry staples (oil, salt, pepper).
    ${profileContext}
    Also calculate estimated nutritional values per serving.`;

    const response = await ai.models.generateContent({
      model: MODEL_TEXT_SEARCH,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            ingredients: { 
              type: Type.ARRAY, 
              items: { 
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    quantity: { type: Type.STRING, description: "e.g. 2 cups, 1 tbsp" },
                    details: { type: Type.STRING, description: "e.g. finely chopped, room temp" }
                },
                required: ["name"]
              } 
            },
            instructions: { type: Type.ARRAY, items: { type: Type.STRING } },
            prepTime: { type: Type.STRING },
            cookTime: { type: Type.STRING },
            servings: { type: Type.INTEGER },
            cuisine: { type: Type.STRING },
            sourceUrl: { type: Type.STRING, description: "A URL to the original recipe source if applicable, or null" },
            nutrition: {
              type: Type.OBJECT,
              properties: {
                calories: { type: Type.INTEGER },
                protein: { type: Type.STRING, description: "e.g. 20g" },
                carbs: { type: Type.STRING, description: "e.g. 30g" },
                fat: { type: Type.STRING, description: "e.g. 10g" },
              },
              required: ["calories", "protein", "carbs", "fat"],
            },
          },
          required: ["title", "description", "ingredients", "instructions", "prepTime", "cookTime", "nutrition"],
        },
      },
    });

    return JSON.parse(response.text || "{}");
  });
}

/**
 * Fetches live prices for ingredients using Google Search Grounding.
 */
export async function fetchIngredientPrices(ingredients: string[]): Promise<PriceSearchResult> {
  return withRetry(async () => {
    const prompt = `Find current average prices for the following ingredients at major US grocery stores (like Walmart, Kroger, Whole Foods): ${ingredients.join(", ")}. Summarize the price ranges concisely.`;
    
    const response = await ai.models.generateContent({
      model: MODEL_TEXT_SEARCH,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    
    return {
      text: response.text || "Could not fetch pricing information.",
      chunks: chunks,
    };
  });
}

/**
 * Generates a visual representation of the final dish using Nano Banana model.
 */
export async function generateDishImage(recipeTitle: string, description: string): Promise<string | null> {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: MODEL_VISION_NANO,
      contents: {
        parts: [
          {
            text: `Professional food photography of ${recipeTitle}. ${description}. High resolution, appetizing, restaurant quality, 4k lighting.`,
          },
        ],
      },
      config: {
        imageConfig: {
            aspectRatio: "16:9",
            imageSize: "1K"
        }
      }
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }
    return null;
  });
}

/**
 * Generates Speech from text using Gemini TTS.
 */
export async function generateSpeech(text: string): Promise<ArrayBuffer | null> {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: MODEL_TTS,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Aoede' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) return null;

    // Decode base64 to ArrayBuffer
    const binaryString = atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  });
}

/**
 * Generates a categorized shopping list, excluding staples.
 */
export async function generateShoppingList(ingredients: string[], pantryStaples: string[]): Promise<ShoppingCategory[]> {
    return withRetry(async () => {
        let prompt = `
        Take this list of ingredients: ${ingredients.join(', ')}.
        1. Remove common pantry staples AND explicitly these items: ${pantryStaples.join(', ')}.
        2. Group the remaining items into logical shopping categories (e.g., Produce, Dairy, Meat, Dry Goods).
        3. Return a JSON structure: [{ "category": "Produce", "items": [{"name": "Carrots", "checked": false}] }].
        `;

        const response = await ai.models.generateContent({
            model: MODEL_TEXT_SEARCH,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            category: { type: Type.STRING },
                            items: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        name: { type: Type.STRING },
                                        checked: { type: Type.BOOLEAN }
                                    },
                                    required: ["name", "checked"]
                                }
                            }
                        },
                        required: ["category", "items"]
                    }
                }
            }
        });

        return JSON.parse(response.text || "[]");
    });
}

/**
 * Gets substitutions for a specific ingredient in a recipe context.
 */
export async function getSubstitutions(ingredient: string, recipeTitle: string): Promise<string> {
    return withRetry(async () => {
        const prompt = `I am making "${recipeTitle}" but I am missing "${ingredient}". 
        Suggest 1-2 viable substitutes I might have, or tell me if I can omit it. Keep it very brief (max 1 sentence).`;
        
        const response = await ai.models.generateContent({
            model: MODEL_TEXT_SEARCH,
            contents: prompt,
        });

        return response.text || "No substitution found.";
    });
}
