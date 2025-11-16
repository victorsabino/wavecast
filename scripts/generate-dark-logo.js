import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const inputPath = join(__dirname, '../assets/logo-header.png');
const outputPath = join(__dirname, '../assets/logo-header-dark.png');

async function generateDarkLogo() {
  try {
    console.log('🎨 Generating dark version of logo...');
    console.log('Input:', inputPath);
    console.log('Output:', outputPath);

    // Load the image
    const image = sharp(inputPath);
    const metadata = await image.metadata();

    console.log('Image size:', `${metadata.width}x${metadata.height}`);

    // Create dark version by:
    // 1. Replace light/white background with dark background
    // 2. Keep the logo colors intact
    await image
      .flatten({ background: '#1a1a1a' }) // Replace transparency/white with dark color
      .toFile(outputPath);

    console.log('✅ Dark logo generated successfully!');
    console.log('Saved to:', outputPath);

  } catch (error) {
    console.error('❌ Error generating dark logo:', error);
    process.exit(1);
  }
}

generateDarkLogo();
