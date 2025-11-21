
export interface Ingredient {
  name: string;
  quantity?: string;
  details?: string;
}

export interface Nutrition {
  calories: number;
  protein: string;
  carbs: string;
  fat: string;
}

export interface Recipe {
  title: string;
  description: string;
  ingredients: Ingredient[];
  instructions: string[];
  prepTime: string;
  cookTime: string;
  servings: number;
  cuisine: string;
  nutrition: Nutrition;
  sourceUrl?: string;
}

export interface UserProfile {
  dietaryRestrictions: string[];
  allergies: string[];
  cuisinePreferences: string[];
  customIngredients: string[];
  pantryStaples: string[];
}

export interface SavedRecipe extends Recipe {
  id: string;
  category: string;
  savedAt: number;
  imageUrl?: string | null;
  rating?: number; 
}

export interface GroundingChunk {
  web?: {
    uri: string;
    title: string;
  };
}

export interface PriceSearchResult {
  text: string;
  chunks: GroundingChunk[];
}

export interface GeneratedImage {
  url: string;
  mimeType: string;
}

export interface ShoppingItem {
  name: string;
  checked: boolean;
}

export interface ShoppingCategory {
  category: string;
  items: ShoppingItem[];
}

export type DayOfWeek = 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';

export interface MealPlan {
  Monday: SavedRecipe[];
  Tuesday: SavedRecipe[];
  Wednesday: SavedRecipe[];
  Thursday: SavedRecipe[];
  Friday: SavedRecipe[];
  Saturday: SavedRecipe[];
  Sunday: SavedRecipe[];
}

export enum AppState {
  IDLE = 'IDLE',
  PROFILE = 'PROFILE',
  SAVED_RECIPES = 'SAVED_RECIPES',
  ANALYZING_FRIDGE = 'ANALYZING_FRIDGE',
  INGREDIENT_CONFIRMATION = 'INGREDIENT_CONFIRMATION',
  GENERATING_RECIPE = 'GENERATING_RECIPE',
  VIEWING_RECIPE = 'VIEWING_RECIPE',
  COOKING_MODE = 'COOKING_MODE',
  SHOPPING_LIST = 'SHOPPING_LIST',
  MEAL_PLANNER = 'MEAL_PLANNER'
}
