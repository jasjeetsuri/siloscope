package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
)

type point struct {
	x int
	y int
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintf(os.Stderr, "usage: %s source.png destination.png\n", os.Args[0])
		os.Exit(2)
	}

	source, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer source.Close()

	decoded, err := png.Decode(source)
	if err != nil {
		panic(err)
	}

	bounds := decoded.Bounds()
	icon := image.NewNRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			icon.Set(x, y, decoded.At(x, y))
		}
	}

	trace := []point{
		{x: 92, y: 560},
		{x: 238, y: 560},
		{x: 336, y: 448},
		{x: 449, y: 650},
		{x: 563, y: 486},
		{x: 672, y: 566},
		{x: 792, y: 394},
		{x: 932, y: 394},
	}

	drawTrace(icon, trace, 38, color.NRGBA{R: 20, G: 15, B: 17, A: 230})
	drawTrace(icon, trace, 19, color.NRGBA{R: 75, G: 199, B: 177, A: 255})
	drawCircle(icon, trace[len(trace)-1], 25, color.NRGBA{R: 20, G: 15, B: 17, A: 230})
	drawCircle(icon, trace[len(trace)-1], 13, color.NRGBA{R: 75, G: 199, B: 177, A: 255})

	destination, err := os.Create(os.Args[2])
	if err != nil {
		panic(err)
	}
	defer destination.Close()

	if err := png.Encode(destination, icon); err != nil {
		panic(err)
	}
}

func drawTrace(destination *image.NRGBA, points []point, radius int, fill color.NRGBA) {
	for index := 1; index < len(points); index++ {
		from := points[index-1]
		to := points[index]
		steps := max(abs(to.x-from.x), abs(to.y-from.y))
		for step := 0; step <= steps; step++ {
			x := from.x + (to.x-from.x)*step/steps
			y := from.y + (to.y-from.y)*step/steps
			drawCircle(destination, point{x: x, y: y}, radius, fill)
		}
	}
}

func drawCircle(destination *image.NRGBA, center point, radius int, fill color.NRGBA) {
	for y := -radius; y <= radius; y++ {
		for x := -radius; x <= radius; x++ {
			if x*x+y*y <= radius*radius {
				destination.SetNRGBA(center.x+x, center.y+y, fill)
			}
		}
	}
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
