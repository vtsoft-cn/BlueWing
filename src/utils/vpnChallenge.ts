/** aTrust expects original image coordinates together with natural image dimensions. */
export function captchaAnswer(
  points: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): string {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    points.length < 1 ||
    points.length > 16
  )
    throw new Error('验证码图片或坐标不正确');
  const coordinates = points.map((p) => {
    if (
      !Number.isInteger(p.x) ||
      !Number.isInteger(p.y) ||
      p.x < 0 ||
      p.x >= width ||
      p.y < 0 ||
      p.y >= height
    )
      throw new Error('验证码坐标超出图片范围');
    return [p.x, p.y];
  });
  return JSON.stringify({ coordinates, width, height });
}
