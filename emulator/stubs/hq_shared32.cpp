// Stub for the MSVC-inline-asm hq scaler helpers (GCC cannot compile them); fc2mp4 never uses
// the hq3xs blitter effect.
void Interp1(unsigned char *, unsigned int, unsigned int) {}
void Interp2(unsigned char *, unsigned int, unsigned int, unsigned int) {}
void Interp3(unsigned char *, unsigned int, unsigned int) {}
void Interp4(unsigned char *, unsigned int, unsigned int, unsigned int) {}
void Interp5(unsigned char *, unsigned int, unsigned int) {}
void Interp1_16(unsigned char *, unsigned short, unsigned short) {}
void Interp2_16(unsigned char *, unsigned short, unsigned short, unsigned short) {}
void Interp3_16(unsigned char *, unsigned short, unsigned short) {}
void Interp4_16(unsigned char *, unsigned short, unsigned short, unsigned short) {}
void Interp5_16(unsigned char *, unsigned short, unsigned short) {}
bool Diff(unsigned int, unsigned int) { return false; }
unsigned int RGBtoYUV(unsigned int c) { return c; }
