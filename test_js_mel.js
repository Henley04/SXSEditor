/**
 * Test JS mel extraction (extractRefMelAsync fallback) 
 */
const path = require('path');
const fs = require('fs');

// Load the bundled postprocessing
const { extractMelSpectrogramAsync } = require('./src/inference/pipeline/postprocessing');

async function test() {
    // Generate a simple sine wave as test audio
    const SAMPLE_RATE = 48000;
    const duration = 5; // seconds
    const samples = new Float32Array(SAMPLE_RATE * duration);
    for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
    }

    console.log(`Testing JS mel extraction: ${samples.length} samples, ${duration}s`);
    const result = await extractMelSpectrogramAsync(samples, SAMPLE_RATE);
    const melData = result.data;
    let nanCount = 0, infCount = 0, sum = 0, finCount = 0;
    for (let i = 0; i < melData.length; i++) {
        if (Number.isNaN(melData[i])) nanCount++;
        else if (!Number.isFinite(melData[i])) infCount++;
        else { sum += melData[i]; finCount++; }
    }
    const mean = finCount > 0 ? sum / finCount : NaN;
    console.log(`Mel output: ${result.frames} frames, ${melData.length} elements, NaN=${nanCount}, Inf=${infCount}, mean=${mean.toFixed(6)}`);
}

test().catch(err => console.error('Error:', err));