import React from 'react';
import { PriceSearchResult } from '../types';

interface Props {
  data: PriceSearchResult;
}

export const GroundingDisplay: React.FC<Props> = ({ data }) => {
  // Simple Markdown-like rendering for bolding
  const renderText = (text: string) => {
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((part, index) => 
      index % 2 === 1 ? <strong key={index} className="font-semibold text-chef-800">{part}</strong> : part
    );
  };

  return (
    <div className="mt-6 p-4 bg-white border border-chef-200 rounded-xl shadow-sm">
      <div className="flex items-center mb-3">
        <div className="p-1.5 bg-blue-100 text-blue-600 rounded-lg mr-2">
           <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-slate-800">Live Market Prices</h3>
      </div>
      
      <div className="prose prose-sm prose-slate text-slate-600 leading-relaxed">
        <p>{renderText(data.text)}</p>
      </div>

      {data.chunks && data.chunks.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-100">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Sources</p>
          <div className="flex flex-wrap gap-2">
            {data.chunks.map((chunk, idx) => (
              chunk.web && (
                <a 
                  key={idx} 
                  href={chunk.web.uri} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center px-3 py-1 bg-slate-50 hover:bg-chef-50 text-chef-700 text-xs rounded-full border border-slate-200 hover:border-chef-300 transition-colors truncate max-w-[200px]"
                >
                  <span className="truncate">{chunk.web.title}</span>
                </a>
              )
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
