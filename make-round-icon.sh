#!/bin/bash

# Script to create a round macOS-style icon

SOURCE_ICON="src-tauri/icons/icon.png"
TEMP_DIR="temp_iconset"
ICONSET_DIR="src-tauri/icons/icon.iconset"

echo "Creating round macOS icon..."

# Clean up any existing iconset
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"
mkdir -p "$TEMP_DIR"

# Function to create a round icon
create_round_icon() {
    local input=$1
    local output=$2
    local size=$3

    # First, resize the source to the target size
    sips -z $size $size "$input" --out "$TEMP_DIR/temp_${size}.png" > /dev/null 2>&1

    # Create a circular mask using Python and PIL (if available) or ImageMagick
    # For macOS, we'll use a simpler approach with transparency

    # Create the rounded version using sips with padding and transparency
    # This creates a circle by making corners transparent
    python3 - "$TEMP_DIR/temp_${size}.png" "$output" $size <<'PYTHON_SCRIPT'
import sys
from PIL import Image, ImageDraw

input_file = sys.argv[1]
output_file = sys.argv[2]
size = int(sys.argv[3])

# Open the image
img = Image.open(input_file).convert("RGBA")

# Create a mask
mask = Image.new('L', (size, size), 0)
draw = ImageDraw.Draw(mask)
draw.ellipse((0, 0, size, size), fill=255)

# Create output with transparency
output = Image.new('RGBA', (size, size), (0, 0, 0, 0))
output.paste(img, (0, 0))
output.putalpha(mask)

# Save
output.save(output_file, 'PNG')
PYTHON_SCRIPT
}

# Check if Python PIL is available
if ! python3 -c "import PIL" 2>/dev/null; then
    echo "Installing pillow for image processing..."
    python3 -m pip install --user pillow -q
fi

# Generate all required sizes for macOS
echo "Generating icon sizes..."

# Standard sizes
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_16x16.png" 16
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_16x16@2x.png" 32
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_32x32.png" 32
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_32x32@2x.png" 64
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_64x64.png" 64
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_128x128.png" 128
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_128x128@2x.png" 256
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_256x256.png" 256
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_256x256@2x.png" 512
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_512x512.png" 512
create_round_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_512x512@2x.png" 1024

# Convert to .icns
echo "Converting to .icns format..."
iconutil -c icns "$ICONSET_DIR" -o "src-tauri/icons/icon.icns"

# Also update the PNG icons used directly
echo "Updating PNG icons..."
create_round_icon "$SOURCE_ICON" "src-tauri/icons/32x32.png" 32
create_round_icon "$SOURCE_ICON" "src-tauri/icons/128x128.png" 128
create_round_icon "$SOURCE_ICON" "src-tauri/icons/128x128@2x.png" 256

# Clean up
rm -rf "$TEMP_DIR"
rm -rf "$ICONSET_DIR"

echo "✓ Round macOS icon created successfully!"
echo "  Generated: src-tauri/icons/icon.icns"
echo "  Updated PNG icons for preview"
