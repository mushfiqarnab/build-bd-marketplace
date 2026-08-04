// components/project/ProjectWizard.jsx
import React, { useState, useCallback, useMemo } from 'react';

// Conversational options configured specifically for local trade understanding in Bangladesh.
// All options use Bengali as the primary label and English as a secondary label to accommodate
// users with lower digital literacy. Min touch target size is 52px (larger than the 48px baseline).
const WIZARD_CATEGORIES = [
  { id: 'Residential', labelBn: 'আবাসিক ভবন (বাড়ি)', labelEn: 'Residential House/Building' },
  { id: 'Commercial', labelBn: 'বাণিজ্যিক ভবন (দোকান/অফিস)', labelEn: 'Commercial Shop/Office' },
  { id: 'Infrastructure', labelBn: 'রাস্তা/ড্রেন/ভিত্তি', labelEn: 'Roads/Drains/Foundations' },
  { id: 'Interior', labelBn: 'ভেতরের ডেকোরেশন (ইন্টেরিয়র)', labelEn: 'Interior Decoration' },
  { id: 'Renovation', labelBn: 'মেরামত বা সংস্কার কাজ', labelEn: 'Repair or Renovation' }
];

const WIZARD_LOCATIONS = [
  { id: 'Dhaka', labelBn: 'ঢাকা', labelEn: 'Dhaka District' },
  { id: 'Chittagong', labelBn: 'চট্টগ্রাম', labelEn: 'Chittagong District' },
  { id: 'Sylhet', labelBn: 'সিলেট', labelEn: 'Sylhet District' },
  { id: 'Khulna', labelBn: 'খুলনা', labelEn: 'Khulna District' },
  { id: 'Rajshahi', labelBn: 'রাজশাহী', labelEn: 'Rajshahi District' }
];

const WIZARD_PRIORITIES = [
  { id: 'LOW', labelBn: 'জরুরি নয় (বাজেট কম)', labelEn: 'Not Urgent (Low Budget)' },
  { id: 'MEDIUM', labelBn: 'মাঝারি জরুরি (স্বাভাবিক)', labelEn: 'Medium (Standard)' },
  { id: 'HIGH', labelBn: 'খুবই জরুরি (দ্রুত কাজ শুরু)', labelEn: 'Highly Urgent (Fast Track)' }
];

export const STEPS = Object.freeze({
  CATEGORY: 'CATEGORY',
  LOCATION: 'LOCATION',
  SCOPE: 'SCOPE',
  PRIORITY: 'PRIORITY',
  SUCCESS: 'SUCCESS'
});

export function useProjectWizard(onSubmitCallback) {
  const [step, setStep] = useState(STEPS.CATEGORY);
  const [formData, setFormData] = useState({
    category: '',
    location: '',
    scopeDescription: '',
    priority: ''
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [matchCount, setMatchCount] = useState(0);

  const setCategory = useCallback((category) => {
    setFormData((prev) => ({ ...prev, category }));
    setError(null);
  }, []);

  const setLocation = useCallback((location) => {
    setFormData((prev) => ({ ...prev, location }));
    setError(null);
  }, []);

  const setScopeDescription = useCallback((scopeDescription) => {
    setFormData((prev) => ({ ...prev, scopeDescription }));
    setError(null);
  }, []);

  const setPriority = useCallback((priority) => {
    setFormData((prev) => ({ ...prev, priority }));
    setError(null);
  }, []);

  const validateCurrentStep = useCallback(() => {
    if (step === STEPS.CATEGORY && !formData.category) {
      setError('দয়া করে কাজের ধরন সিলেক্ট করুন / Please select a work category.');
      return false;
    }
    if (step === STEPS.LOCATION && !formData.location) {
      setError('দয়া করে আপনার জেলা সিলেক্ট করুন / Please select your district.');
      return false;
    }
    if (step === STEPS.SCOPE) {
      const cleanDesc = formData.scopeDescription.trim();
      if (cleanDesc.length < 20) {
        setError('কাজের বিবরণ কমপক্ষে ২০ অক্ষরের হতে হবে / Description must be at least 20 characters.');
        return false;
      }
    }
    if (step === STEPS.PRIORITY && !formData.priority) {
      setError('দয়া করে কাজের গুরুত্ব সিলেক্ট করুন / Please select work urgency.');
      return false;
    }
    setError(null);
    return true;
  }, [step, formData]);

  const goNext = useCallback(() => {
    if (!validateCurrentStep()) return;
    if (step === STEPS.CATEGORY) setStep(STEPS.LOCATION);
    else if (step === STEPS.LOCATION) setStep(STEPS.SCOPE);
    else if (step === STEPS.SCOPE) setStep(STEPS.PRIORITY);
  }, [step, validateCurrentStep]);

  const goBack = useCallback(() => {
    setError(null);
    if (step === STEPS.LOCATION) setStep(STEPS.CATEGORY);
    else if (step === STEPS.SCOPE) setStep(STEPS.LOCATION);
    else if (step === STEPS.PRIORITY) setStep(STEPS.SCOPE);
  }, [step]);

  const submitWizard = useCallback(async () => {
    if (!validateCurrentStep()) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await onSubmitCallback(formData);
      setMatchCount(result.matchCount || 0);
      setStep(STEPS.SUCCESS);
    } catch (err) {
      setError(err.message || 'সাবমিট করতে সমস্যা হয়েছে। আবার চেষ্টা করুন / Submission failed. Please retry.');
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, validateCurrentStep, onSubmitCallback]);

  return {
    step,
    formData,
    isSubmitting,
    error,
    matchCount,
    setCategory,
    setLocation,
    setScopeDescription,
    setPriority,
    goNext,
    goBack,
    submitWizard
  };
}

export function ProjectWizard({ onSubmit }) {
  const {
    step,
    formData,
    isSubmitting,
    error,
    matchCount,
    setCategory,
    setLocation,
    setScopeDescription,
    setPriority,
    goNext,
    goBack,
    submitWizard
  } = useProjectWizard(onSubmit);

  // Large grid options with min 52px target size. Zero browser selects.
  const renderTileGrid = (items, selectedValue, onSelect) => (
    <div style={styles.grid}>
      {items.map((item) => {
        const isSelected = selectedValue === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            style={{
              ...styles.tile,
              backgroundColor: isSelected ? '#1e3a8a' : '#f3f4f6',
              color: isSelected ? '#ffffff' : '#1f2937',
              border: isSelected ? '2px solid #2563eb' : '2px solid #e5e7eb'
            }}
          >
            <div style={styles.tileBn}>{item.labelBn}</div>
            <div style={{ ...styles.tileEn, color: isSelected ? '#93c5fd' : '#4b5563' }}>{item.labelEn}</div>
          </button>
        );
      })}
    </div>
  );

  return (
    <div style={styles.container}>
      {/* HEADER STATE GAUGE */}
      {step !== STEPS.SUCCESS && (
        <div style={styles.header}>
          <h2 style={styles.titleBn}>নতুন কাজের বিজ্ঞাপন দিন</h2>
          <h3 style={styles.titleEn}>Post a Construction Job RFQ</h3>
          <div style={styles.progressTrack}>
            <div
              style={{
                ...styles.progressBar,
                width:
                  step === STEPS.CATEGORY ? '25%' :
                  step === STEPS.LOCATION ? '50%' :
                  step === STEPS.SCOPE ? '75%' : '95%'
              }}
            />
          </div>
        </div>
      )}

      {/* ERROR HUD */}
      {error && (
        <div style={styles.errorHud}>
          <div style={styles.errorText}>{error}</div>
        </div>
      )}

      {/* STEP 1: CATEGORY SELECTION */}
      {step === STEPS.CATEGORY && (
        <div>
          <h4 style={styles.promptBn}>১. কাজের বিষয় নির্বাচন করুন:</h4>
          <h5 style={styles.promptEn}>1. Select the Type of Work:</h5>
          {renderTileGrid(WIZARD_CATEGORIES, formData.category, setCategory)}
          <div style={styles.actionBar}>
            <button
              onClick={goNext}
              disabled={!formData.category}
              style={{ ...styles.btnPrimary, opacity: formData.category ? 1 : 0.5 }}
            >
              পরবর্তী ধাপ / Next Step ➜
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: DISTRICT LOCATION */}
      {step === STEPS.LOCATION && (
        <div>
          <h4 style={styles.promptBn}>২. আপনার এলাকা নির্বাচন করুন:</h4>
          <h5 style={styles.promptEn}>2. Select Your District Location:</h5>
          {renderTileGrid(WIZARD_LOCATIONS, formData.location, setLocation)}
          <div style={styles.actionBar}>
            <button onClick={goBack} style={styles.btnSecondary}>
              ⬅ পূর্ববর্তী / Back
            </button>
            <button
              onClick={goNext}
              disabled={!formData.location}
              style={{ ...styles.btnPrimary, opacity: formData.location ? 1 : 0.5 }}
            >
              পরবর্তী ধাপ / Next Step ➜
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: SCOPE DESCRIPTION */}
      {step === STEPS.SCOPE && (
        <div>
          <h4 style={styles.promptBn}>৩. কাজের বিবরণ লিখুন (কমপক্ষে ২০ অক্ষর):</h4>
          <h5 style={styles.promptEn}>3. Write a Short Description (Min 20 characters):</h5>
          <textarea
            value={formData.scopeDescription}
            onChange={(e) => setScopeDescription(e.target.value)}
            placeholder="উদাহরণ: ২য় তলার ছাদ ঢালাইয়ের জন্য ৪ ইঞ্চি রড বাইন্ডিং এবং সেন্টারিং কাজের মিস্ত্রি প্রয়োজন..."
            style={styles.textarea}
            rows={5}
          />
          <div style={styles.charCounter}>
            দৈর্ঘ্য / Characters: {formData.scopeDescription.trim().length} (কমপক্ষে ২০ প্রয়োজন / Min 20 required)
          </div>
          <div style={styles.actionBar}>
            <button onClick={goBack} style={styles.btnSecondary}>
              ⬅ পূর্ববর্তী / Back
            </button>
            <button
              onClick={goNext}
              disabled={formData.scopeDescription.trim().length < 20}
              style={{
                ...styles.btnPrimary,
                opacity: formData.scopeDescription.trim().length >= 20 ? 1 : 0.5
              }}
            >
              পরবর্তী ধাপ / Next Step ➜
            </button>
          </div>
        </div>
      )}

      {/* STEP 4: PRIORITY & VERIFY */}
      {step === STEPS.PRIORITY && (
        <div>
          <h4 style={styles.promptBn}>৪. কাজ শুরুর সময় / বাজেট কেমন?</h4>
          <h5 style={styles.promptEn}>4. Urgency & Estimated Budget Tier:</h5>
          {renderTileGrid(WIZARD_PRIORITIES, formData.priority, setPriority)}
          <div style={styles.actionBar}>
            <button onClick={goBack} style={styles.btnSecondary} disabled={isSubmitting}>
              ⬅ পূর্ববর্তী / Back
            </button>
            <button
              onClick={submitWizard}
              disabled={!formData.priority || isSubmitting}
              style={{
                ...styles.btnSubmit,
                opacity: (formData.priority && !isSubmitting) ? 1 : 0.5
              }}
            >
              {isSubmitting ? 'প্রক্রিয়াকরণ হচ্ছে / Submitting...' : 'বিজ্ঞাপন প্রকাশ করুন / Publish RFQ 🚀'}
            </button>
          </div>
        </div>
      )}

      {/* STEP 5: SUCCESS MATCH ENGINE RESPONSE */}
      {step === STEPS.SUCCESS && (
        <div style={styles.successCard}>
          <div style={styles.successIcon}>✓</div>
          <h2 style={styles.successTitleBn}>বিজ্ঞাপন সফলভাবে প্রকাশিত হয়েছে!</h2>
          <h3 style={styles.successTitleEn}>RFQ Successfully Published!</h3>
          
          <div style={styles.matchHud}>
            <div style={styles.matchNumber}>{matchCount}</div>
            <div style={styles.matchLabelBn}>আপনার এলাকায় অভিজ্ঞ ঠিকাদার পাওয়া গেছে যারা এই ক্যাটাগরিতে কাজ করতে ইচ্ছুক।</div>
            <div style={styles.matchLabelEn}>Verified contractors found in your district matches this category scope.</div>
          </div>

          <div style={styles.successNoteBn}>
            ঠিকাদাররা আপনার বিবরণ দেখে খুব শীঘ্রই বিড (দরপত্র) সাবমিট করবে। আপনার মোবাইলে এসএমএস পাঠানো হবে।
          </div>
          <div style={styles.successNoteEn}>
            Contractors will review your requirements and submit proposals shortly. You will be notified via SMS.
          </div>
        </div>
      )}
    </div>
  );
}

// Low-overhead CSS-in-JS style object to prevent layout reflows and memory allocations in Android WebViews
const styles = {
  container: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '600px',
    margin: '0 auto',
    padding: '16px',
    backgroundColor: '#ffffff',
    borderRadius: '12px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
  },
  header: {
    marginBottom: '20px'
  },
  titleBn: {
    fontSize: '20px',
    fontWeight: 'bold',
    color: '#1e3a8a',
    margin: '0 0 4px 0',
    textAlign: 'center'
  },
  titleEn: {
    fontSize: '14px',
    color: '#4b5563',
    margin: '0 0 16px 0',
    textAlign: 'center'
  },
  progressTrack: {
    width: '100%',
    height: '6px',
    backgroundColor: '#e5e7eb',
    borderRadius: '3px',
    overflow: 'hidden'
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#2563eb',
    transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
  },
  promptBn: {
    fontSize: '16px',
    fontWeight: 'bold',
    color: '#111827',
    margin: '0 0 4px 0'
  },
  promptEn: {
    fontSize: '13px',
    color: '#6b7280',
    margin: '0 0 16px 0'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '12px',
    marginBottom: '20px'
  },
  tile: {
    width: '100%',
    minHeight: '64px', // Exceeds 48px tactile target cap
    padding: '12px 16px',
    borderRadius: '8px',
    textAlign: 'left',
    cursor: 'pointer',
    outline: 'none',
    transition: 'background-color 0.15s ease, border-color 0.15s ease'
  },
  tileBn: {
    fontSize: '15px',
    fontWeight: 'bold',
    marginBottom: '2px'
  },
  tileEn: {
    fontSize: '12px'
  },
  textarea: {
    width: '100%',
    padding: '12px',
    fontSize: '15px',
    borderRadius: '8px',
    border: '2px solid #d1d5db',
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: '6px',
    resize: 'none'
  },
  charCounter: {
    fontSize: '12px',
    color: '#6b7280',
    marginBottom: '20px'
  },
  errorHud: {
    backgroundColor: '#fee2e2',
    borderLeft: '4px solid #ef4444',
    padding: '12px',
    borderRadius: '6px',
    marginBottom: '16px'
  },
  errorText: {
    fontSize: '13px',
    color: '#991b1b',
    fontWeight: '500'
  },
  actionBar: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    marginTop: '24px'
  },
  btnPrimary: {
    flex: 1,
    height: '52px', // Touch target size
    backgroundColor: '#2563eb',
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: '15px',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer'
  },
  btnSecondary: {
    padding: '0 16px',
    height: '52px',
    backgroundColor: '#e5e7eb',
    color: '#374151',
    fontWeight: '500',
    fontSize: '14px',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer'
  },
  btnSubmit: {
    flex: 1,
    height: '52px',
    backgroundColor: '#10b981',
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: '15px',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer'
  },
  successCard: {
    textAlign: 'center',
    padding: '24px 16px'
  },
  successIcon: {
    width: '64px',
    height: '64px',
    lineHeight: '64px',
    borderRadius: '32px',
    backgroundColor: '#d1fae5',
    color: '#059669',
    fontSize: '32px',
    margin: '0 auto 16px auto',
    fontWeight: 'bold'
  },
  successTitleBn: {
    fontSize: '22px',
    fontWeight: 'bold',
    color: '#065f46',
    margin: '0 0 4px 0'
  },
  successTitleEn: {
    fontSize: '15px',
    color: '#374151',
    margin: '0 0 24px 0'
  },
  matchHud: {
    backgroundColor: '#eff6ff',
    border: '1px solid #bfdbfe',
    borderRadius: '12px',
    padding: '20px 16px',
    marginBottom: '24px'
  },
  matchNumber: {
    fontSize: '48px',
    fontWeight: '900',
    color: '#1d4ed8',
    marginBottom: '8px',
    lineHeight: 1
  },
  matchLabelBn: {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#1e40af',
    marginBottom: '4px'
  },
  matchLabelEn: {
    fontSize: '12px',
    color: '#1e3a8a'
  },
  successNoteBn: {
    fontSize: '13px',
    color: '#4b5563',
    lineHeight: 1.5,
    marginBottom: '4px'
  },
  successNoteEn: {
    fontSize: '12px',
    color: '#6b7280',
    lineHeight: 1.5
  }
};
