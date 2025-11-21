
import React, { useState, useRef, useEffect } from 'react';
import { AppState, Recipe, PriceSearchResult, UserProfile, SavedRecipe, ShoppingCategory, ShoppingItem, MealPlan, DayOfWeek, Ingredient } from './types';
import { analyzeFridgeImage, generateRecipe, fetchIngredientPrices, generateDishImage, generateSpeech, generateShoppingList, getSubstitutions } from './services/geminiService';
import { decodeAudioData } from './utils/audioUtils';
import { Spinner } from './components/Spinner';
import { GroundingDisplay } from './components/GroundingDisplay';

// --- Constants ---
const DEFAULT_PROFILE: UserProfile = {
    dietaryRestrictions: [],
    allergies: [],
    cuisinePreferences: [],
    customIngredients: [],
    pantryStaples: ['Salt', 'Pepper', 'Olive Oil', 'Water', 'Sugar', 'Flour']
};

const DIETARY_OPTIONS = ["Vegetarian", "Vegan", "Gluten-Free", "Keto", "Paleo", "Dairy-Free"];
const ALLERGY_OPTIONS = ["Peanuts", "Tree Nuts", "Dairy", "Eggs", "Shellfish", "Soy", "Wheat"];
const RECIPE_CATEGORIES = ["Favorites", "Weeknight Meals", "Desserts", "Breakfast", "Lunch", "Dinner", "Other"];
const DAYS_OF_WEEK: DayOfWeek[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const DEFAULT_MEAL_PLAN: MealPlan = {
    Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: []
};

// --- Helper Functions ---

const parseDuration = (text: string): number | null => {
    if (!text) return null;
    // Regex to find minutes or seconds. Matches "5 minutes", "1 hr", "30 secs"
    const match = text.match(/(\d+)\s*(minute|min|second|sec|hour|hr)/i);
    if (match) {
        const val = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        if (unit.startsWith('min')) return val * 60;
        if (unit.startsWith('sec')) return val;
        if (unit.startsWith('hour') || unit.startsWith('hr')) return val * 3600;
    }
    return null;
};

function App() {
    // State
    const [appState, setAppState] = useState<AppState>(AppState.IDLE);
    const [molecularInputs, setMolecularInputs] = useState<string[]>([]); // Raw detected molecularInputs
    const [synthesisProtocol, setSynthesisProtocol] = useState<Recipe | null>(null);
    const [priceData, setPriceData] = useState<PriceSearchResult | null>(null);
    const [generatedImage, setGeneratedImage] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);

    // Profile & Saved Recipes State
    const [biometricPreferences, setBiometricPreferences] = useState<UserProfile>(DEFAULT_PROFILE);
    const [savedRecipes, setSavedRecipes] = useState<SavedRecipe[]>([]);
    const [recentlyViewed, setRecentlyViewed] = useState<SavedRecipe[]>([]);
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [selectedCategory, setSelectedCategory] = useState(RECIPE_CATEGORIES[0]);
    const [customCategory, setCustomCategory] = useState("");
    const [manualSourceUrl, setManualSourceUrl] = useState("");
    const [savedRecipesSearch, setSavedRecipesSearch] = useState("");

    // Meal Plan State
    const [mealPlan, setMealPlan] = useState<MealPlan>(DEFAULT_MEAL_PLAN);
    // Removed unused state showMealPlanModal if not used, or kept if intended for future.
    const [showMealPlanModal, setShowMealPlanModal] = useState(false);

    // Cooking Mode State
    const [executionPhaseIndex, setExecutionPhaseIndex] = useState(0);
    const [voiceEnabled, setVoiceEnabled] = useState(false);
    const [temporalConstraint, setTemporalConstraint] = useState<{ secondsLeft: number, isActive: boolean, duration: number } | null>(null);
    const [showCookingIngredients, setShowCookingIngredients] = useState(false);
    const [cookingIngredientsChecklist, setCookingIngredientsChecklist] = useState<Record<string, boolean>>({});

    // Shopping List State
    const [shoppingList, setShoppingList] = useState<ShoppingCategory[]>([]);

    // Substitution State
    const [substitutions, setSubstitutions] = useState<Record<string, string>>({});
    const [loadingSub, setLoadingSub] = useState<string | null>(null);

    // DND State
    const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

    // Refs
    const fileInputRef = useRef<HTMLInputElement>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
    const recognitionRef = useRef<any>(null);
    const timerIntervalRef = useRef<number | null>(null);

    // --- Effects ---
    useEffect(() => {
        const savedProfile = localStorage.getItem('chefGenius_profile');
        if (savedProfile) {
            try { setBiometricPreferences(JSON.parse(savedProfile)); } catch (e) { }
        }

        const savedRecs = localStorage.getItem('chefGenius_savedRecipes');
        if (savedRecs) {
            try { setSavedRecipes(JSON.parse(savedRecs)); } catch (e) { }
        }

        const savedPlan = localStorage.getItem('chefGenius_mealPlan');
        if (savedPlan) {
            try { setMealPlan(JSON.parse(savedPlan)); } catch (e) { }
        }

        const savedHistory = localStorage.getItem('chefGenius_recentlyViewed');
        if (savedHistory) {
            try { setRecentlyViewed(JSON.parse(savedHistory)); } catch (e) { }
        }
    }, []);

    // Cooking Mode temporalConstraint
    useEffect(() => {
        if (temporalConstraint?.isActive && temporalConstraint.secondsLeft > 0) {
            timerIntervalRef.current = window.setInterval(() => {
                setTemporalConstraint(prev => {
                    if (!prev) return null;
                    if (prev.secondsLeft <= 1) {
                        // temporalConstraint finished
                        return { ...prev, secondsLeft: 0, isActive: false };
                    }
                    return { ...prev, secondsLeft: prev.secondsLeft - 1 };
                });
            }, 1000);
        } else {
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        }
        return () => { if (timerIntervalRef.current) clearInterval(timerIntervalRef.current); };
    }, [temporalConstraint?.isActive]);

    // Voice Recognition for Cooking Mode
    useEffect(() => {
        if (appState === AppState.COOKING_MODE && voiceEnabled) {
            const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

            if (SpeechRecognition) {
                const recognition = new SpeechRecognition();
                recognition.continuous = true;
                recognition.lang = 'en-US';
                recognition.interimResults = false;

                recognition.onresult = (event: any) => {
                    const last = event.results.length - 1;
                    const command = event.results[last][0].transcript.trim().toLowerCase();
                    console.log("Voice Command:", command);

                    if (command.includes('next')) {
                        handleNextStep();
                    } else if (command.includes('back') || command.includes('previous')) {
                        handlePrevStep();
                    } else if (command.includes('start temporalConstraint') || command.includes('begin temporalConstraint')) {
                        if (synthesisProtocol) {
                            const currentInst = synthesisProtocol.instructions[executionPhaseIndex];
                            const duration = parseDuration(currentInst);
                            if (duration) startTimer(duration);
                        }
                    }
                };

                recognition.onerror = (e: any) => console.error("Speech recognition error", e);
                recognition.start();
                recognitionRef.current = recognition;
            } else {
                console.warn("Speech recognition not supported in this browser.");
            }
        } else {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
                recognitionRef.current = null;
            }
        }

        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
            }
        };
    }, [appState, voiceEnabled, executionPhaseIndex, synthesisProtocol]);

    // --- Handlers ---

    const updateProfile = (newProfile: UserProfile) => {
        setBiometricPreferences(newProfile);
        localStorage.setItem('chefGenius_profile', JSON.stringify(newProfile));
    };

    const saveRecipe = () => {
        if (!synthesisProtocol) return;
        const finalCategory = selectedCategory === "Other" && customCategory.trim() ? customCategory.trim() : selectedCategory;
        const finalSourceUrl = manualSourceUrl.trim() ? manualSourceUrl.trim() : synthesisProtocol.sourceUrl;

        const newSavedRecipe: SavedRecipe = {
            ...synthesisProtocol,
            id: Date.now().toString(),
            savedAt: Date.now(),
            category: finalCategory,
            imageUrl: generatedImage,
            rating: 0,
            sourceUrl: finalSourceUrl
        };

        const updated = [newSavedRecipe, ...savedRecipes];
        setSavedRecipes(updated);
        try {
            localStorage.setItem('chefGenius_savedRecipes', JSON.stringify(updated));
            setShowSaveModal(false);
            alert('synthesisProtocol saved!');
        } catch (e) {
            alert('Storage full! Could not save image.');
        }
    };

    const updateRecipeRating = (id: string, rating: number, e: React.MouseEvent) => {
        e.stopPropagation();
        const updated = savedRecipes.map(r => r.id === id ? { ...r, rating } : r);
        setSavedRecipes(updated);
        localStorage.setItem('chefGenius_savedRecipes', JSON.stringify(updated));
    };

    const deleteSavedRecipe = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const updated = savedRecipes.filter(r => r.id !== id);
        setSavedRecipes(updated);
        localStorage.setItem('chefGenius_savedRecipes', JSON.stringify(updated));

        // Also remove from meal plan
        const newPlan = { ...mealPlan };
        DAYS_OF_WEEK.forEach(day => {
            newPlan[day] = newPlan[day].filter(r => r.id !== id);
        });
        setMealPlan(newPlan);
        localStorage.setItem('chefGenius_mealPlan', JSON.stringify(newPlan));
    };

    const addToMealPlan = (day: DayOfWeek, recipeToAdd: SavedRecipe) => {
        const currentDayPlan = mealPlan[day];
        // Avoid duplicates for same meal same day
        if (currentDayPlan.find(r => r.id === recipeToAdd.id)) return;

        const updatedPlan = {
            ...mealPlan,
            [day]: [...currentDayPlan, recipeToAdd]
        };
        setMealPlan(updatedPlan);
        localStorage.setItem('chefGenius_mealPlan', JSON.stringify(updatedPlan));
        setShowMealPlanModal(false);
    };

    const removeFromMealPlan = (day: DayOfWeek, recipeId: string) => {
        const updatedPlan = {
            ...mealPlan,
            [day]: mealPlan[day].filter(r => r.id !== recipeId)
        };
        setMealPlan(updatedPlan);
        localStorage.setItem('chefGenius_mealPlan', JSON.stringify(updatedPlan));
    };

    const loadSavedRecipe = (saved: SavedRecipe) => {
        setSynthesisProtocol(saved);
        setGeneratedImage(saved.imageUrl || null);
        setPriceData(null);
        setSubstitutions({});
        setCookingIngredientsChecklist({});
        setAppState(AppState.VIEWING_RECIPE);

        // Add to Recently Viewed
        const newHistory = [saved, ...recentlyViewed.filter(r => r.id !== saved.id)].slice(0, 5);
        setRecentlyViewed(newHistory);
        localStorage.setItem('chefGenius_recentlyViewed', JSON.stringify(newHistory));
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setAppState(AppState.ANALYZING_FRIDGE);
        setLoading(true);
        setError(null);

        try {
            const reader = new FileReader();
            reader.onloadend = async () => {
                const base64String = (reader.result as string).split(',')[1];
                const mimeType = file.type;

                const detectedIngredients = await analyzeFridgeImage(base64String, mimeType);
                setMolecularInputs(detectedIngredients);
                setAppState(AppState.INGREDIENT_CONFIRMATION);
            };
            reader.readAsDataURL(file);
        } catch (err) {
            console.error(err);
            setError("Failed to analyze image. Please try again.");
            setAppState(AppState.IDLE);
        } finally {
            setLoading(false);
        }
    };

    const executeSynthesisSequence = async () => {
        if (molecularInputs.length === 0 && biometricPreferences.customIngredients.length === 0) return;

        setAppState(AppState.GENERATING_RECIPE);
        setLoading(true);
        setError(null);

        try {
            const [recipeResult, priceResult] = await Promise.all([
                generateRecipe(molecularInputs, biometricPreferences),
                fetchIngredientPrices(molecularInputs)
            ]);

            setSynthesisProtocol(recipeResult);
            setPriceData(priceResult);
            setSubstitutions({});
            setCookingIngredientsChecklist({});
            setAppState(AppState.VIEWING_RECIPE);

            generateDishImage(recipeResult.title, recipeResult.description).then(img => {
                if (img) setGeneratedImage(img);
            });

        } catch (err) {
            console.error(err);
            setError("Failed to generate synthesisProtocol. Please check your connection.");
            setAppState(AppState.INGREDIENT_CONFIRMATION);
        } finally {
            setLoading(false);
        }
    };

    const handleGenerateShoppingList = async () => {
        if (!synthesisProtocol) return;
        setLoading(true);
        try {
            // Handle object vs string ingredient structure
            const ingredientNames = synthesisProtocol.ingredients.map(ing =>
                typeof ing === 'string' ? ing : ing.name
            );
            const list = await generateShoppingList(ingredientNames, biometricPreferences.pantryStaples);
            setShoppingList(list);
            setAppState(AppState.SHOPPING_LIST);
        } catch (e) {
            setError("Could not generate shopping list.");
        } finally {
            setLoading(false);
        }
    };

    const handleGetSubstitution = async (ingredientName: string) => {
        if (!synthesisProtocol) return;
        setLoadingSub(ingredientName);
        try {
            const sub = await getSubstitutions(ingredientName, synthesisProtocol.title);
            setSubstitutions(prev => ({ ...prev, [ingredientName]: sub }));
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingSub(null);
        }
    };

    const handleShare = async () => {
        if (!synthesisProtocol) return;
        const ingredientText = synthesisProtocol.ingredients.map(ing =>
            typeof ing === 'string' ? ing : `${ing.quantity || ''} ${ing.name}`
        ).join('\n');

        const text = `${synthesisProtocol.title}\n\n${synthesisProtocol.description}\n\nIngredients:\n${ingredientText}`;

        if (navigator.share) {
            try {
                await navigator.share({
                    title: synthesisProtocol.title,
                    text: text,
                    url: synthesisProtocol.sourceUrl
                });
            } catch (e) {
                console.log("Share dismissed");
            }
        } else {
            navigator.clipboard.writeText(text);
            alert("synthesisProtocol copied to clipboard!");
        }
    };

    const handleShareMealPlan = async () => {
        let summary = "My Weekly Meal Plan:\n\n";
        DAYS_OF_WEEK.forEach(day => {
            const meals = mealPlan[day];
            if (meals.length > 0) {
                summary += `${day}:\n`;
                meals.forEach(m => summary += ` - ${m.title}\n`);
                summary += "\n";
            }
        });

        if (navigator.share) {
            try {
                await navigator.share({ title: "My Meal Plan", text: summary });
            } catch (e) { console.log("Share dismissed"); }
        } else {
            navigator.clipboard.writeText(summary);
            alert("Meal plan copied to clipboard!");
        }
    };

    const handlePlayAudio = async (text: string) => {
        if (isPlaying) {
            if (audioSourceRef.current) {
                audioSourceRef.current.stop();
                setIsPlaying(false);
            }
            return;
        }

        try {
            // Don't block UI too much
            const audioBufferRaw = await generateSpeech(text);
            if (!audioBufferRaw) return;

            if (!audioContextRef.current) {
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            }

            const ctx = audioContextRef.current;
            if (ctx.state === 'suspended') await ctx.resume();

            const audioBuffer = await decodeAudioData(audioBufferRaw, ctx, 24000);

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.onended = () => setIsPlaying(false);

            audioSourceRef.current = source;
            source.start();
            setIsPlaying(true);

        } catch (err) {
            console.error("Audio playback error", err);
            setError("Could not play audio.");
        }
    };

    const addIngredient = (val: string) => {
        if (val.trim()) setMolecularInputs(prev => [...prev, val.trim()]);
    };

    const removeIngredient = (idx: number) => {
        setMolecularInputs(prev => prev.filter((_, i) => i !== idx));
    };

    // Drag and Drop Handlers
    const handleDragStart = (index: number) => {
        setDraggedIdx(index);
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
    };

    const handleDrop = (index: number) => {
        if (draggedIdx === null) return;
        setMolecularInputs(prev => {
            const newIngredients = [...prev];
            const [movedItem] = newIngredients.splice(draggedIdx, 1);
            newIngredients.splice(index, 0, movedItem);
            return newIngredients;
        });
        setDraggedIdx(null);
    };

    const addCustomIngredient = (val: string) => {
        if (val.trim() && !biometricPreferences.customIngredients.includes(val.trim())) {
            updateProfile({
                ...biometricPreferences,
                customIngredients: [...biometricPreferences.customIngredients, val.trim()]
            });
        }
    };
    const removeCustomIngredient = (idx: number) => {
        updateProfile({
            ...biometricPreferences,
            customIngredients: biometricPreferences.customIngredients.filter((_, i) => i !== idx)
        });
    };

    const addPantryStaple = (val: string) => {
        if (val.trim() && !biometricPreferences.pantryStaples.includes(val.trim())) {
            updateProfile({
                ...biometricPreferences,
                pantryStaples: [...biometricPreferences.pantryStaples, val.trim()]
            });
        }
    };

    const removePantryStaple = (idx: number) => {
        updateProfile({
            ...biometricPreferences,
            pantryStaples: biometricPreferences.pantryStaples.filter((_, i) => i !== idx)
        });
    };

    // Cooking Mode Navigation & temporalConstraint

    const handleNextStep = () => {
        setExecutionPhaseIndex(prev => {
            if (synthesisProtocol && prev < synthesisProtocol.instructions.length - 1) {
                const nextStep = prev + 1;
                setTemporalConstraint(null); // Reset temporalConstraint on step change
                return nextStep;
            }
            return prev;
        });
    };
    const handlePrevStep = () => {
        setExecutionPhaseIndex(prev => {
            if (prev > 0) {
                setTemporalConstraint(null);
                return prev - 1;
            }
            return prev;
        });
    };

    const startTimer = (seconds: number) => {
        setTemporalConstraint({ secondsLeft: seconds, duration: seconds, isActive: true });
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    };


    // --- Render Helpers ---

    const renderHeader = () => (
        <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
            <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
                <div
                    className="flex items-center gap-2 text-chef-600 cursor-pointer"
                    onClick={() => setAppState(AppState.IDLE)}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    <h1 className="text-xl font-bold tracking-tight text-slate-900">Cooking Mama</h1>
                </div>

                <div className="flex items-center gap-4">
                    <button
                        onClick={() => setAppState(AppState.MEAL_PLANNER)}
                        className={`text-sm font-medium transition-colors ${appState === AppState.MEAL_PLANNER ? 'text-chef-600 font-bold' : 'text-slate-500 hover:text-chef-600'}`}
                    >
                        Meal Plan
                    </button>
                    <button
                        onClick={() => setAppState(AppState.SAVED_RECIPES)}
                        className={`text-sm font-medium transition-colors ${appState === AppState.SAVED_RECIPES ? 'text-chef-600 font-bold' : 'text-slate-500 hover:text-chef-600'}`}
                    >
                        Saved ({savedRecipes.length})
                    </button>
                    <button
                        onClick={() => setAppState(AppState.PROFILE)}
                        className={`text-sm font-medium transition-colors ${appState === AppState.PROFILE ? 'text-chef-600 font-bold' : 'text-slate-500 hover:text-chef-600'}`}
                    >
                        Profile
                    </button>
                </div>
            </div>
        </header>
    );

    const renderProfile = () => {
        const toggleSelection = (list: string[], item: string) => {
            return list.includes(item) ? list.filter(i => i !== item) : [...list, item];
        };

        return (
            <div className="max-w-3xl mx-auto mt-8 px-4 pb-20">
                <h2 className="text-3xl font-bold text-slate-900 mb-2">Your Food Profile</h2>
                <p className="text-slate-500 mb-8">Tell us about your dietary needs so we can suggest better recipes.</p>

                <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 space-y-8">

                    {/* Diet */}
                    <div>
                        <h3 className="text-lg font-semibold text-slate-800 mb-3">Dietary Restrictions</h3>
                        <div className="flex flex-wrap gap-3">
                            {DIETARY_OPTIONS.map(opt => (
                                <button
                                    key={opt}
                                    onClick={() => updateProfile({ ...biometricPreferences, dietaryRestrictions: toggleSelection(biometricPreferences.dietaryRestrictions, opt) })}
                                    className={`px-4 py-2 rounded-full text-sm font-medium border transition-all ${biometricPreferences.dietaryRestrictions.includes(opt)
                                        ? 'bg-chef-600 text-white border-chef-600 shadow-sm'
                                        : 'bg-white text-slate-600 border-slate-200 hover:border-chef-300'
                                        }`}
                                >
                                    {opt}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Allergies */}
                    <div>
                        <h3 className="text-lg font-semibold text-slate-800 mb-3">Allergies (Avoid)</h3>
                        <div className="flex flex-wrap gap-3">
                            {ALLERGY_OPTIONS.map(opt => (
                                <button
                                    key={opt}
                                    onClick={() => updateProfile({ ...biometricPreferences, allergies: toggleSelection(biometricPreferences.allergies, opt) })}
                                    className={`px-4 py-2 rounded-full text-sm font-medium border transition-all ${biometricPreferences.allergies.includes(opt)
                                        ? 'bg-red-500 text-white border-red-500 shadow-sm'
                                        : 'bg-white text-slate-600 border-slate-200 hover:border-red-200'
                                        }`}
                                >
                                    {opt}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Cuisines */}
                    <div>
                        <h3 className="text-lg font-semibold text-slate-800 mb-3">Favorite Cuisines</h3>
                        <input
                            type="text"
                            placeholder="e.g. Italian, Mexican, Thai (comma separated)"
                            value={biometricPreferences.cuisinePreferences.join(", ")}
                            onChange={(e) => updateProfile({ ...biometricPreferences, cuisinePreferences: e.target.value.split(',').map(s => s.trim()) })}
                            className="w-full border border-slate-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-chef-500 outline-none"
                        />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Custom molecularInputs */}
                        <div>
                            <h3 className="text-lg font-semibold text-slate-800 mb-3">Always Include (Custom)</h3>
                            <div className="flex gap-2 mb-3">
                                <input
                                    type="text"
                                    placeholder="e.g. Truffle Oil"
                                    className="flex-1 border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-chef-500 outline-none"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            addCustomIngredient(e.currentTarget.value);
                                            e.currentTarget.value = '';
                                        }
                                    }}
                                />
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {biometricPreferences.customIngredients.map((ing, idx) => (
                                    <div key={idx} className="flex items-center bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-sm">
                                        {ing}
                                        <button onClick={() => removeCustomIngredient(idx)} className="ml-2 text-slate-400 hover:text-red-500">
                                            &times;
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Pantry Staples */}
                        <div>
                            <h3 className="text-lg font-semibold text-slate-800 mb-3">Pantry Staples (Don't Shop)</h3>
                            <div className="flex gap-2 mb-3">
                                <input
                                    type="text"
                                    placeholder="e.g. Salt, Olive Oil"
                                    className="flex-1 border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-chef-500 outline-none"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            addPantryStaple(e.currentTarget.value);
                                            e.currentTarget.value = '';
                                        }
                                    }}
                                />
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {biometricPreferences.pantryStaples.map((ing, idx) => (
                                    <div key={idx} className="flex items-center bg-amber-50 text-amber-800 px-3 py-1 rounded-full text-sm border border-amber-100">
                                        {ing}
                                        <button onClick={() => removePantryStaple(idx)} className="ml-2 text-amber-400 hover:text-amber-700">
                                            &times;
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="pt-4 flex justify-end">
                        <button
                            onClick={() => setAppState(AppState.IDLE)}
                            className="bg-slate-900 text-white px-8 py-3 rounded-xl font-semibold hover:bg-slate-800 transition-colors"
                        >
                            Save & Close
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    const renderSavedRecipes = () => {
        const [catFilter, setCatFilter] = useState("All");
        const [cuisineFilter, setCuisineFilter] = useState("All");
        const [timeFilter, setTimeFilter] = useState("All");
        const [matchProfile, setMatchProfile] = useState(false);

        const cuisines = ["All", ...Array.from(new Set(savedRecipes.map(r => r.cuisine)))];

        let filtered = savedRecipes;

        if (savedRecipesSearch) {
            const q = savedRecipesSearch.toLowerCase();
            filtered = filtered.filter(r =>
                r.title.toLowerCase().includes(q) ||
                r.description.toLowerCase().includes(q)
            );
        }

        if (catFilter !== "All") {
            filtered = filtered.filter(r => r.category === catFilter);
        }
        if (cuisineFilter !== "All") {
            filtered = filtered.filter(r => r.cuisine === cuisineFilter);
        }
        if (timeFilter === "Quick") {
            filtered = filtered.filter(r => {
                const prep = parseDuration(r.prepTime) || 0;
                const cook = parseDuration(r.cookTime) || 0;
                return (prep + cook) <= 1800;
            });
        }

        if (matchProfile) {
            if (biometricPreferences.allergies.length > 0) {
                filtered = filtered.filter(r => {
                    // Handle potential string vs object molecularInputs for safety
                    const ingString = r.ingredients.map(i => typeof i === 'string' ? i : i.name).join(' ');
                    const allText = (ingString + r.title).toLowerCase();
                    return !biometricPreferences.allergies.some(allergen => allText.includes(allergen.toLowerCase()));
                });
            }
            if (biometricPreferences.dietaryRestrictions.length > 0) {
                filtered = [...filtered].sort((a, b) => {
                    const aScore = biometricPreferences.dietaryRestrictions.reduce((acc, res) => acc + ((a.title + a.description).includes(res) ? 1 : 0), 0);
                    const bScore = biometricPreferences.dietaryRestrictions.reduce((acc, res) => acc + ((b.title + b.description).includes(res) ? 1 : 0), 0);
                    return bScore - aScore;
                });
            }
        }

        const renderStars = (rating: number = 0, id: string) => {
            return (
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    {[1, 2, 3, 4, 5].map(star => (
                        <svg
                            key={star}
                            onClick={(e) => updateRecipeRating(id, star, e)}
                            xmlns="http://www.w3.org/2000/svg"
                            className={`h-5 w-5 cursor-pointer transition-colors ${star <= rating ? 'text-yellow-400 fill-current' : 'text-slate-300'}`}
                            viewBox="0 0 20 20"
                            fill="currentColor"
                        >
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                    ))}
                </div>
            );
        };

        return (
            <div className="max-w-6xl mx-auto mt-8 px-4 pb-12">
                <h2 className="text-3xl font-bold text-slate-900 mb-6">Saved Recipes</h2>

                {recentlyViewed.length > 0 && (
                    <div className="mb-8">
                        <h3 className="text-lg font-semibold text-slate-700 mb-3 flex items-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            Recently Viewed
                        </h3>
                        <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
                            {recentlyViewed.map(rv => (
                                <div
                                    key={`rv-${rv.id}`}
                                    onClick={() => loadSavedRecipe(rv)}
                                    className="min-w-[200px] w-[200px] bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden cursor-pointer hover:shadow-md transition-all"
                                >
                                    <div className="h-24 bg-slate-100">
                                        {rv.imageUrl ? <img src={rv.imageUrl} alt="" className="w-full h-full object-cover" /> : null}
                                    </div>
                                    <div className="p-3">
                                        <h4 className="font-bold text-sm text-slate-800 truncate">{rv.title}</h4>
                                        <p className="text-xs text-slate-500">{rv.cookTime}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-6 flex flex-col gap-4">
                    <div className="w-full">
                        <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                <svg className="h-5 w-5 text-slate-400" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" /></svg>
                            </div>
                            <input
                                type="text"
                                placeholder="Search saved recipes..."
                                value={savedRecipesSearch}
                                onChange={(e) => setSavedRecipesSearch(e.target.value)}
                                className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg leading-5 bg-slate-50 placeholder-slate-400 focus:outline-none focus:ring-chef-500 focus:border-chef-500 sm:text-sm transition duration-150 ease-in-out"
                            />
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-4 items-center">
                        <div className="flex overflow-x-auto gap-2 scrollbar-hide flex-1 min-w-[200px]">
                            <button
                                onClick={() => setCatFilter("All")}
                                className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium transition-colors ${catFilter === "All" ? 'bg-chef-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                                All
                            </button>
                            {RECIPE_CATEGORIES.filter(c => c !== "Other").map(cat => (
                                <button
                                    key={cat}
                                    onClick={() => setCatFilter(cat)}
                                    className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium transition-colors ${catFilter === cat ? 'bg-chef-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                >
                                    {cat}
                                </button>
                            ))}
                            <button
                                onClick={() => setCatFilter("Other")}
                                className={`whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium transition-colors ${catFilter === "Other" ? 'bg-chef-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                                Other
                            </button>
                        </div>

                        <div className="h-8 w-px bg-slate-200 hidden md:block"></div>
                        <select
                            value={cuisineFilter}
                            onChange={(e) => setCuisineFilter(e.target.value)}
                            className="bg-slate-50 border border-slate-200 text-slate-700 text-sm rounded-lg focus:ring-chef-500 focus:border-chef-500 block p-2.5"
                        >
                            {cuisines.map(c => <option key={c} value={c}>{c === 'All' ? 'All Cuisines' : c}</option>)}
                        </select>
                        <select
                            value={timeFilter}
                            onChange={(e) => setTimeFilter(e.target.value)}
                            className="bg-slate-50 border border-slate-200 text-slate-700 text-sm rounded-lg focus:ring-chef-500 focus:border-chef-500 block p-2.5"
                        >
                            <option value="All">Any Time</option>
                            <option value="Quick">Quick Prep (Total &lt; 30m)</option>
                        </select>
                    </div>

                    <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                        <div
                            onClick={() => setMatchProfile(!matchProfile)}
                            className={`cursor-pointer flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-colors ${matchProfile ? 'bg-green-100 text-green-700 font-medium' : 'bg-slate-100 text-slate-600'}`}
                        >
                            <div className={`w-4 h-4 rounded border flex items-center justify-center ${matchProfile ? 'bg-green-500 border-green-500' : 'bg-white border-slate-400'}`}>
                                {matchProfile && <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
                            </div>
                            Match My Profile (Allergies)
                        </div>
                    </div>
                </div>

                {filtered.length === 0 ? (
                    <div className="text-center py-20 bg-white rounded-2xl border border-slate-200 border-dashed">
                        <p className="text-slate-400">No saved recipes match your filters.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filtered.map(saved => (
                            <div
                                key={saved.id}
                                onClick={() => loadSavedRecipe(saved)}
                                className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden cursor-pointer hover:shadow-md transition-all group flex flex-col"
                            >
                                <div className="h-48 bg-slate-100 relative overflow-hidden">
                                    {saved.imageUrl ? (
                                        <img src={saved.imageUrl} alt={saved.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-slate-300">
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                        </div>
                                    )}
                                    <span className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm px-2 py-1 rounded text-xs font-bold text-slate-700 shadow-sm">
                                        {saved.category}
                                    </span>
                                </div>
                                <div className="p-4 flex-1 flex flex-col">
                                    <h3 className="text-lg font-bold text-slate-900 mb-1 line-clamp-1">{saved.title}</h3>
                                    <div className="flex justify-between items-center text-sm text-slate-500 mb-3">
                                        <span>{saved.nutrition.calories} kcal</span>
                                        <span>{saved.cookTime}</span>
                                    </div>

                                    <div className="mt-auto pt-3 border-t border-slate-100 flex justify-between items-center">
                                        {renderStars(saved.rating, saved.id)}
                                        <div className="flex gap-2">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    const day = prompt("Enter day (e.g. Monday) to add to meal plan:") as DayOfWeek;
                                                    if (day && DAYS_OF_WEEK.includes(day)) addToMealPlan(day, saved);
                                                }}
                                                className="text-slate-400 hover:text-chef-600 p-1"
                                                title="Add to Meal Plan"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                                            </button>
                                            <button
                                                onClick={(e) => deleteSavedRecipe(saved.id, e)}
                                                className="text-slate-400 hover:text-red-500 p-1"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const renderMealPlanner = () => (
        <div className="max-w-7xl mx-auto mt-8 px-4 pb-20">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-3xl font-bold text-slate-900">Weekly Meal Plan</h2>
                <button
                    onClick={handleShareMealPlan}
                    className="flex items-center gap-2 px-4 py-2 bg-chef-50 text-chef-700 font-bold rounded-lg hover:bg-chef-100 transition-colors"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                    Share Plan
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
                {DAYS_OF_WEEK.map(day => (
                    <div key={day} className="bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col h-full min-h-[300px]">
                        <div className="p-3 border-b border-slate-100 bg-slate-50 rounded-t-xl font-bold text-slate-700 text-center">
                            {day}
                        </div>
                        <div className="p-2 flex-1 space-y-2">
                            {mealPlan[day].map(planRecipe => (
                                <div key={planRecipe.id} className="relative group bg-white border border-slate-200 p-2 rounded-lg shadow-sm hover:shadow-md transition-all">
                                    {planRecipe.imageUrl && <img src={planRecipe.imageUrl} className="w-full h-24 object-cover rounded mb-2" alt="" />}
                                    <h4 className="font-bold text-sm text-slate-800 line-clamp-2 mb-1">{planRecipe.title}</h4>
                                    <div className="flex justify-between items-center mt-1">
                                        <span className="text-xs text-slate-500">{planRecipe.cookTime}</span>
                                        <div className="flex gap-1">
                                            <button
                                                onClick={() => loadSavedRecipe(planRecipe)}
                                                className="text-chef-600 hover:text-chef-800"
                                                title="View"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                            </button>
                                            <button
                                                onClick={() => removeFromMealPlan(day, planRecipe.id)}
                                                className="text-slate-400 hover:text-red-500"
                                                title="Remove"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {mealPlan[day].length === 0 && (
                                <div className="h-full flex items-center justify-center text-slate-300 text-xs">
                                    No meals planned
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    const renderIdle = () => (
        <div className="flex flex-col items-center justify-center min-h-[80vh] px-4 text-center">
            <div className="w-24 h-24 bg-chef-100 text-chef-600 rounded-full flex items-center justify-center mb-6 shadow-inner">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
            </div>
            <h2 className="text-3xl font-bold text-slate-900 mb-4">What's in your fridge?</h2>
            <p className="text-slate-500 max-w-md mb-8 text-lg">
                Upload a photo of your molecularInputs. Our Nano Banana vision model will analyze them, suggest a synthesisProtocol, check live prices, and help you cook.
            </p>

            <div className="flex flex-col w-full max-w-xs gap-4">
                <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full bg-chef-600 hover:bg-chef-700 text-white font-semibold py-4 px-8 rounded-full shadow-lg hover:shadow-xl transition-all transform hover:-translate-y-1 flex items-center justify-center gap-3"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Upload Fridge Photo
                </button>

                <div className="flex items-center gap-3">
                    <div className="h-px bg-slate-200 flex-1"></div>
                    <span className="text-slate-400 text-sm font-medium uppercase">or</span>
                    <div className="h-px bg-slate-200 flex-1"></div>
                </div>

                <button
                    onClick={() => {
                        setMolecularInputs([]);
                        setAppState(AppState.INGREDIENT_CONFIRMATION);
                    }}
                    className="w-full bg-white border-2 border-slate-200 hover:border-chef-500 text-slate-600 hover:text-chef-700 font-semibold py-3 px-8 rounded-full transition-all flex items-center justify-center gap-2 group"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-400 group-hover:text-chef-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Enter molecularInputs Manually
                </button>
            </div>

            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleFileUpload}
            />

            <div className="mt-6 flex flex-col items-center gap-2">
                {biometricPreferences.dietaryRestrictions.length > 0 && (
                    <div className="flex gap-2 items-center text-sm text-slate-500">
                        <span>Restrictions:</span>
                        {biometricPreferences.dietaryRestrictions.map(r => (
                            <span key={r} className="bg-slate-100 px-2 py-0.5 rounded text-slate-600 font-medium">{r}</span>
                        ))}
                    </div>
                )}
                {biometricPreferences.customIngredients.length > 0 && (
                    <div className="flex gap-2 items-center text-sm text-slate-500">
                        <span>Including:</span>
                        {biometricPreferences.customIngredients.map(r => (
                            <span key={r} className="bg-emerald-50 px-2 py-0.5 rounded text-emerald-600 font-medium border border-emerald-100">{r}</span>
                        ))}
                    </div>
                )}
            </div>

            <p className="mt-8 text-xs text-slate-400">Powered by Gemini Nano Banana & Google Search Grounding</p>
        </div>
    );

    const renderIngredientConfirmation = () => (
        <div className="max-w-2xl mx-auto mt-12 px-4">
            <h2 className="text-2xl font-bold text-slate-900 mb-2">Confirm molecularInputs</h2>
            <p className="text-slate-500 mb-6">Add, remove, or reorder items to prioritize them.</p>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 mb-8">
                <div className="flex flex-wrap gap-2 mb-4">
                    {molecularInputs.map((ing, idx) => (
                        <div
                            key={idx}
                            draggable
                            onDragStart={() => handleDragStart(idx)}
                            onDragOver={(e) => handleDragOver(e, idx)}
                            onDrop={() => handleDrop(idx)}
                            className={`flex items-center bg-chef-50 text-chef-800 px-3 py-1.5 rounded-full border border-chef-100 text-sm font-medium animate-fadeIn cursor-move hover:bg-chef-100 transition-colors ${draggedIdx === idx ? 'opacity-50' : ''}`}
                        >
                            <svg className="w-3 h-3 mr-1 text-chef-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
                            {ing}
                            <button onClick={() => removeIngredient(idx)} className="ml-2 text-chef-400 hover:text-chef-700">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                </svg>
                            </button>
                        </div>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input
                        type="text"
                        placeholder="Add another ingredient..."
                        className="flex-1 border border-slate-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-chef-500 focus:border-transparent outline-none"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                addIngredient(e.currentTarget.value);
                                e.currentTarget.value = '';
                            }
                        }}
                    />
                </div>
            </div>

            <div className="flex justify-end gap-4">
                <button
                    onClick={() => setAppState(AppState.IDLE)}
                    className="px-6 py-3 text-slate-600 font-medium hover:bg-slate-100 rounded-xl transition-colors"
                >
                    Back
                </button>
                <button
                    onClick={executeSynthesisSequence}
                    disabled={molecularInputs.length === 0 && biometricPreferences.customIngredients.length === 0}
                    className="bg-chef-600 hover:bg-chef-700 text-white font-bold py-3 px-8 rounded-xl shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                    {loading ? <Spinner /> : 'Generate synthesisProtocol'}
                </button>
            </div>
        </div>
    );

    const renderRecipe = () => {
        if (!synthesisProtocol) return null;

        return (
            <div className="max-w-4xl mx-auto px-4 py-8 pb-24">
                {/* synthesisProtocol Header */}
                <div className="flex justify-between items-start mb-6">
                    <div className="flex items-center gap-2">
                        <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded text-xs font-bold uppercase tracking-wide">{synthesisProtocol.cuisine}</span>
                        <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-bold uppercase tracking-wide">{synthesisProtocol.nutrition.calories} kcal</span>
                    </div>
                    <div className="relative flex gap-2">
                        <button
                            onClick={handleShare}
                            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors shadow-sm"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
                            Share
                        </button>
                        <button
                            onClick={handleGenerateShoppingList}
                            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors shadow-sm"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                            List
                        </button>
                        <div className="relative">
                            <button
                                onClick={() => {
                                    setShowSaveModal(prev => !prev);
                                    // Initialize source URL state if not set
                                    if (!manualSourceUrl && synthesisProtocol.sourceUrl) setManualSourceUrl(synthesisProtocol.sourceUrl);
                                }}
                                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors shadow-sm"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
                                </svg>
                                Save
                            </button>
                            {showSaveModal && (
                                <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-xl shadow-xl border border-slate-100 p-4 z-20 animate-fadeIn">
                                    <p className="text-xs font-semibold text-slate-500 mb-2 uppercase">Category</p>
                                    <div className="space-y-1 max-h-40 overflow-y-auto mb-2">
                                        {RECIPE_CATEGORIES.map(cat => (
                                            <button
                                                key={cat}
                                                onClick={() => { setSelectedCategory(cat); }}
                                                className={`block w-full text-left px-3 py-2 rounded-lg text-sm ${selectedCategory === cat ? 'bg-chef-50 text-chef-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
                                            >
                                                {cat}
                                            </button>
                                        ))}
                                    </div>

                                    {selectedCategory === "Other" && (
                                        <div className="mb-3">
                                            <input
                                                type="text"
                                                placeholder="Custom Category Name"
                                                value={customCategory}
                                                onChange={(e) => setCustomCategory(e.target.value)}
                                                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-chef-500 outline-none"
                                            />
                                        </div>
                                    )}

                                    <div className="mb-3 border-t border-slate-100 pt-3">
                                        <p className="text-xs font-semibold text-slate-500 mb-2 uppercase">Source URL</p>
                                        <input
                                            type="text"
                                            placeholder="https://example.com/synthesisProtocol"
                                            value={manualSourceUrl}
                                            onChange={(e) => setManualSourceUrl(e.target.value)}
                                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-chef-500 outline-none"
                                        />
                                    </div>

                                    <button
                                        onClick={saveRecipe}
                                        className="w-full py-2 bg-chef-600 text-white text-sm font-bold rounded-lg hover:bg-chef-700"
                                    >
                                        Confirm Save
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
                    <div>
                        <h1 className="text-4xl font-extrabold text-slate-900 mb-4 leading-tight">{synthesisProtocol.title}</h1>
                        <p className="text-slate-600 text-lg mb-6 leading-relaxed">{synthesisProtocol.description}</p>

                        {(synthesisProtocol.sourceUrl || manualSourceUrl) && (
                            <a href={manualSourceUrl || synthesisProtocol.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mb-4">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                View Original Source
                            </a>
                        )}

                        <div className="flex gap-6 text-sm font-medium text-slate-700 border-y border-slate-100 py-4">
                            <div className="flex flex-col items-center">
                                <span className="text-slate-400 uppercase text-xs mb-1">Prep</span>
                                {synthesisProtocol.prepTime}
                            </div>
                            <div className="w-px bg-slate-200"></div>
                            <div className="flex flex-col items-center">
                                <span className="text-slate-400 uppercase text-xs mb-1">Cook</span>
                                {synthesisProtocol.cookTime}
                            </div>
                            <div className="w-px bg-slate-200"></div>
                            <div className="flex flex-col items-center">
                                <span className="text-slate-400 uppercase text-xs mb-1">Serves</span>
                                {synthesisProtocol.servings}
                            </div>
                        </div>

                        {/* Nutrition Grid */}
                        <div className="grid grid-cols-4 gap-2 mt-6">
                            <div className="bg-slate-50 p-3 rounded-lg text-center">
                                <div className="text-xs text-slate-400 uppercase font-bold">Cal</div>
                                <div className="font-bold text-slate-700">{synthesisProtocol.nutrition.calories}</div>
                            </div>
                            <div className="bg-slate-50 p-3 rounded-lg text-center">
                                <div className="text-xs text-slate-400 uppercase font-bold">Pro</div>
                                <div className="font-bold text-slate-700">{synthesisProtocol.nutrition.protein}</div>
                            </div>
                            <div className="bg-slate-50 p-3 rounded-lg text-center">
                                <div className="text-xs text-slate-400 uppercase font-bold">Carb</div>
                                <div className="font-bold text-slate-700">{synthesisProtocol.nutrition.carbs}</div>
                            </div>
                            <div className="bg-slate-50 p-3 rounded-lg text-center">
                                <div className="text-xs text-slate-400 uppercase font-bold">Fat</div>
                                <div className="font-bold text-slate-700">{synthesisProtocol.nutrition.fat}</div>
                            </div>
                        </div>

                        <button
                            onClick={() => { setExecutionPhaseIndex(0); setCookingIngredientsChecklist({}); setAppState(AppState.COOKING_MODE); }}
                            className="mt-8 w-full py-4 bg-gradient-to-r from-chef-600 to-chef-500 hover:from-chef-700 hover:to-chef-600 text-white rounded-xl font-bold shadow-lg shadow-chef-200 transform transition-all hover:scale-[1.02] flex items-center justify-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            Start Cooking Mode
                        </button>

                    </div>

                    {/* Dynamic Image Generation */}
                    <div className="relative aspect-video bg-slate-200 rounded-2xl overflow-hidden shadow-inner">
                        {generatedImage ? (
                            <img src={generatedImage} alt={synthesisProtocol.title} className="w-full h-full object-cover animate-fadeIn" />
                        ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                                <Spinner />
                                <span className="mt-2 text-sm">Generating dish preview...</span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Left Column: molecularInputs & Prices */}
                    <div className="lg:col-span-1 space-y-6">
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
                            <h3 className="text-xl font-bold text-slate-900 mb-4">molecularInputs</h3>
                            <ul className="space-y-4">
                                {synthesisProtocol.ingredients.map((ing, i) => {
                                    // Handle legacy string molecularInputs gracefully
                                    const name = typeof ing === 'string' ? ing : ing.name;
                                    const quantity = typeof ing === 'object' ? ing.quantity : null;
                                    const details = typeof ing === 'object' ? ing.details : null;
                                    const sub = substitutions[name];

                                    return (
                                        <li key={i} className="flex flex-col gap-1 text-slate-700">
                                            <div className="flex items-start gap-2">
                                                <div className="min-w-[6px] h-[6px] mt-2 rounded-full bg-chef-400" />
                                                <div>
                                                    <span className="font-medium">{quantity ? `${quantity} ` : ''}</span>
                                                    <span>{name}</span>
                                                    {details && <span className="text-slate-500 text-sm italic block">{details}</span>}
                                                </div>
                                            </div>

                                            <div className="ml-4 mt-1">
                                                {sub ? (
                                                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 p-2 rounded-lg text-sm text-amber-800 shadow-sm">
                                                        <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                                                        <div>
                                                            <span className="font-bold text-amber-900">Sub found:</span> {sub}
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={() => handleGetSubstitution(name)}
                                                        className="text-xs text-slate-400 hover:text-chef-600 underline flex items-center gap-1"
                                                        disabled={loadingSub === name}
                                                    >
                                                        {loadingSub === name ? "Finding..." : "Need a substitute?"}
                                                    </button>
                                                )}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                        {/* Search Grounding Price Check */}
                        {priceData && <GroundingDisplay data={priceData} />}
                    </div>

                    {/* Right Column: Instructions */}
                    <div className="lg:col-span-2">
                        <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100">
                            <div className="flex items-center justify-between mb-6">
                                <h3 className="text-2xl font-bold text-slate-900">Instructions</h3>
                                <button
                                    onClick={() => handlePlayAudio(synthesisProtocol.instructions.join('. '))}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold transition-all ${isPlaying
                                        ? 'bg-red-50 text-red-600 hover:bg-red-100'
                                        : 'bg-chef-50 text-chef-700 hover:bg-chef-100'
                                        }`}
                                >
                                    {loading && !generatedImage ? (
                                        <Spinner />
                                    ) : isPlaying ? (
                                        <>
                                            <span className="relative flex h-3 w-3">
                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                                            </span>
                                            Stop Audio
                                        </>
                                    ) : (
                                        <>
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                                            </svg>
                                            Listen
                                        </>
                                    )}
                                </button>
                            </div>

                            <div className="space-y-8">
                                {synthesisProtocol.instructions.map((step, i) => (
                                    <div key={i} className="flex gap-4 group">
                                        <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-chef-100 text-chef-700 font-bold text-sm group-hover:bg-chef-600 group-hover:text-white transition-colors">
                                            {i + 1}
                                        </div>
                                        <p className="text-slate-700 leading-relaxed pt-1">{step}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const toggleShoppingItem = (catIndex: number, itemIndex: number) => {
        setShoppingList(prev => {
            const newList = [...prev];
            const cat = { ...newList[catIndex] };
            const items = [...cat.items];
            items[itemIndex] = { ...items[itemIndex], checked: !items[itemIndex].checked };
            cat.items = items;
            newList[catIndex] = cat;
            return newList;
        });
    };

    const renderShoppingList = () => (
        <div className="max-w-3xl mx-auto mt-8 px-4 pb-20">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-3xl font-bold text-slate-900">Shopping List</h2>
                <div className="flex gap-2">
                    <button
                        onClick={() => {
                            const text = shoppingList.map(cat =>
                                `${cat.category}:\n` + cat.items.map(i => ` - ${i.name}`).join('\n')
                            ).join('\n\n');
                            navigator.clipboard.writeText(text);
                            alert("List copied!");
                        }}
                        className="px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-medium hover:bg-slate-50"
                    >
                        Copy
                    </button>
                    <button
                        onClick={() => setAppState(AppState.VIEWING_RECIPE)}
                        className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800"
                    >
                        Done
                    </button>
                </div>
            </div>

            {shoppingList.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-xl border border-slate-200 border-dashed">
                    <p className="text-slate-500">Your shopping list is empty.</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {shoppingList.map((cat, cIdx) => (
                        <div key={cIdx} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                            <div className="bg-slate-50 px-4 py-2 border-b border-slate-100 font-bold text-slate-700">
                                {cat.category}
                            </div>
                            <div className="p-2">
                                {cat.items.map((item, iIdx) => (
                                    <div
                                        key={iIdx}
                                        onClick={() => toggleShoppingItem(cIdx, iIdx)}
                                        className="flex items-center p-3 hover:bg-slate-50 rounded-lg cursor-pointer transition-colors"
                                    >
                                        <div className={`w-5 h-5 rounded border flex items-center justify-center mr-3 transition-colors ${item.checked ? 'bg-green-500 border-green-500' : 'border-slate-300'}`}>
                                            {item.checked && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                                        </div>
                                        <span className={`${item.checked ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{item.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const renderCookingMode = () => {
        if (!synthesisProtocol) return null;
        const currentInstruction = synthesisProtocol.instructions[executionPhaseIndex];
        const detectableTime = !temporalConstraint?.isActive ? parseDuration(currentInstruction) : null;

        return (
            <div className="fixed inset-0 bg-white z-50 flex flex-col">
                <div className="h-16 border-b border-slate-100 flex items-center justify-between px-6 bg-white">
                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => setAppState(AppState.VIEWING_RECIPE)}
                            className="text-slate-500 hover:text-slate-800 font-medium flex items-center gap-1"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            Exit
                        </button>
                        <div className="h-6 w-px bg-slate-200"></div>
                        <span className="font-bold text-slate-900 truncate max-w-[200px] sm:max-w-md">{synthesisProtocol.title}</span>
                    </div>

                    <div className="flex items-center gap-4">
                        <button
                            onClick={() => setShowCookingIngredients(prev => !prev)}
                            className={`px-4 py-2 rounded-full text-sm font-bold transition-colors ${showCookingIngredients ? 'bg-chef-100 text-chef-700' : 'bg-slate-100 text-slate-600'}`}
                        >
                            molecularInputs
                        </button>
                        <button
                            onClick={() => setVoiceEnabled(prev => !prev)}
                            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold transition-colors ${voiceEnabled ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-slate-100 text-slate-600'}`}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                            {voiceEnabled ? 'Listening...' : 'Voice Control'}
                        </button>
                    </div>
                </div>

                <div className="flex-1 flex overflow-hidden">
                    <div className="flex-1 flex flex-col relative overflow-y-auto">
                        <div className="h-1 bg-slate-100 w-full">
                            <div
                                className="h-full bg-chef-500 transition-all duration-300"
                                style={{ width: `${((executionPhaseIndex + 1) / synthesisProtocol.instructions.length) * 100}%` }}
                            />
                        </div>

                        <div className="flex-1 flex flex-col items-center justify-center p-8 max-w-4xl mx-auto w-full text-center">
                            <div className="text-chef-600 font-bold uppercase tracking-widest mb-4 text-sm">
                                Step {executionPhaseIndex + 1} of {synthesisProtocol.instructions.length}
                            </div>
                            <h2 className="text-3xl md:text-5xl font-bold text-slate-900 leading-tight mb-12">
                                {currentInstruction}
                            </h2>

                            {temporalConstraint?.isActive && (
                                <div className="mb-8 inline-flex flex-col items-center justify-center w-48 h-48 rounded-full border-4 border-chef-500 bg-chef-50 text-chef-800 shadow-lg animate-pulse-slow">
                                    <span className="text-5xl font-mono font-bold">{formatTime(temporalConstraint.secondsLeft)}</span>
                                    <span className="text-sm font-bold uppercase mt-1">temporalConstraint</span>
                                    <button
                                        onClick={() => setTemporalConstraint(null)}
                                        className="mt-2 text-xs text-red-500 hover:underline"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            )}

                            {!temporalConstraint?.isActive && detectableTime && (
                                <button
                                    onClick={() => startTimer(detectableTime)}
                                    className="mb-8 bg-chef-100 text-chef-700 px-6 py-3 rounded-xl font-bold hover:bg-chef-200 transition-colors flex items-center gap-2"
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    Start temporalConstraint ({Math.floor(detectableTime / 60)}m)
                                </button>
                            )}
                        </div>

                        <div className="p-6 border-t border-slate-100 flex justify-between items-center bg-white">
                            <button
                                onClick={handlePrevStep}
                                disabled={executionPhaseIndex === 0}
                                className="px-8 py-4 rounded-xl font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent flex items-center gap-2 transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                Previous
                            </button>

                            <div className="flex gap-2">
                                <button
                                    onClick={() => handlePlayAudio(currentInstruction)}
                                    className="p-4 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                                    title="Read Aloud"
                                >
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
                                </button>
                            </div>

                            <button
                                onClick={handleNextStep}
                                disabled={executionPhaseIndex === synthesisProtocol.instructions.length - 1}
                                className="px-8 py-4 rounded-xl font-bold bg-chef-600 text-white hover:bg-chef-700 shadow-lg disabled:opacity-50 disabled:shadow-none flex items-center gap-2 transition-all"
                            >
                                Next Step
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                            </button>
                        </div>
                    </div>

                    {showCookingIngredients && (
                        <div className="w-80 bg-slate-50 border-l border-slate-200 overflow-y-auto p-6 animate-slideLeft">
                            <h3 className="font-bold text-slate-900 mb-4 text-lg">molecularInputs</h3>
                            <div className="space-y-3">
                                {synthesisProtocol.ingredients.map((ing, idx) => {
                                    const name = typeof ing === 'string' ? ing : ing.name;
                                    const qty = typeof ing === 'object' ? ing.quantity : '';
                                    const isChecked = cookingIngredientsChecklist[name];

                                    return (
                                        <div
                                            key={idx}
                                            onClick={() => setCookingIngredientsChecklist(prev => ({ ...prev, [name]: !prev[name] }))}
                                            className={`flex items-start p-3 rounded-lg cursor-pointer transition-all ${isChecked ? 'bg-slate-200/50' : 'bg-white shadow-sm border border-slate-200'}`}
                                        >
                                            <div className={`mt-1 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center mr-3 transition-colors ${isChecked ? 'bg-green-500 border-green-500' : 'border-slate-300'}`}>
                                                {isChecked && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                                            </div>
                                            <div className={`text-sm ${isChecked ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                                                {qty && <span className="font-bold text-slate-900">{qty} </span>}
                                                {name}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // Loading Screen and other conditional renders...

    if (loading && appState !== AppState.VIEWING_RECIPE && appState !== AppState.SHOPPING_LIST && !isPlaying) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50">
                <div className="mb-4 p-4 bg-white rounded-full shadow-lg">
                    <Spinner />
                </div>
                <h3 className="text-lg font-semibold text-slate-700 animate-pulse">
                    {appState === AppState.ANALYZING_FRIDGE ? 'Analyzing your fridge...' : 'Cooking up something special...'}
                </h3>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-50 font-sans">
            {appState !== AppState.COOKING_MODE && renderHeader()}

            {error && (
                <div className="max-w-md mx-auto mt-4 p-4 bg-red-50 text-red-700 rounded-lg flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    {error}
                </div>
            )}

            <main>
                {appState === AppState.IDLE && renderIdle()}
                {appState === AppState.PROFILE && renderProfile()}
                {appState === AppState.SAVED_RECIPES && renderSavedRecipes()}
                {appState === AppState.INGREDIENT_CONFIRMATION && renderIngredientConfirmation()}
                {appState === AppState.VIEWING_RECIPE && renderRecipe()}
                {appState === AppState.COOKING_MODE && renderCookingMode()}
                {appState === AppState.SHOPPING_LIST && renderShoppingList()}
                {appState === AppState.MEAL_PLANNER && renderMealPlanner()}
            </main>
        </div>
    );
}

export default App;

