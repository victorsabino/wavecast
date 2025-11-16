#!/bin/bash

# Script to create a visibly round icon with rounded corners baked in

SOURCE_ICON="src-tauri/icons/icon.png"
TEMP_DIR="temp_iconset"
ICONSET_DIR="src-tauri/icons/icon.iconset"

echo "Creating visibly round icon with rounded corners..."

# Clean up
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"
mkdir -p "$TEMP_DIR"

# Function to create a rounded square icon (macOS style with ~22% radius)
create_rounded_icon() {
    local input=$1
    local output=$2
    local size=$3

    # Calculate corner radius (22.37% is the macOS standard)
    local radius=$(echo "$size * 0.2237" | bc | cut -d'.' -f1)

    python3 - "$input" "$output" $size $radius <<'PYTHON_SCRIPT'
import sys
from PIL import Image, ImageDraw

input_file = sys.argv[1]
output_file = sys.argv[2]
size = int(sys.argv[3])
radius = int(sys.argv[4])

# Open and resize the image
img = Image.open(input_file).convert("RGBA")
img = img.resize((size, size), Image.Resampling.LANCZOS)

# Create a rounded rectangle mask
mask = Image.new('L', (size, size), 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle([(0, 0), (size-1, size-1)], radius=radius, fill=255)

# Create output with transparency
output = Image.new('RGBA', (size, size), (0, 0, 0, 0))
output.paste(img, (0, 0))
output.putalpha(mask)

# Save
output.save(output_file, 'PNG')
print(f"Created {output_file} ({size}x{size} with radius {radius})")
PYTHON_SCRIPT
}

# Check if Python PIL is available
if ! python3 -c "import PIL" 2>/dev/null; then
    echo "Installing pillow..."
    python3 -m pip install --user pillow -q
fi

echo "Generating rounded square icons (macOS style)..."

# Generate all required sizes
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_16x16.png" 16
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_16x16@2x.png" 32
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_32x32.png" 32
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_32x32@2x.png" 64
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_128x128.png" 128
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_128x128@2x.png" 256
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_256x256.png" 256
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_256x256@2x.png" 512
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_512x512.png" 512
create_rounded_icon "$SOURCE_ICON" "$ICONSET_DIR/icon_512x512@2x.png" 1024

# Convert to .icns
echo "Converting to .icns format..."
iconutil -c icns "$ICONSET_DIR" -o "src-tauri/icons/icon.icns"

# Update the direct PNG icons
echo "Updating PNG icons..."
create_rounded_icon "$SOURCE_ICON" "src-tauri/icons/32x32.png" 32
create_rounded_icon "$SOURCE_ICON" "src-tauri/icons/128x128.png" 128
create_rounded_icon "$SOURCE_ICON" "src-tauri/icons/128x128@2x.png" 256

# Clean up
rm -rf "$TEMP_DIR"
rm -rf "$ICONSET_DIR"

echo "✓ Rounded square icon created successfully!"
echo "  The icon now has visible rounded corners baked in"
echo "  Restart the app to see the changes"
