import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";
import * as THREE from "three";
import { GLOBE_FOV, globeAt } from "../choreography";
import { C, H, W } from "../tokens";

const earthVertex = /* glsl */ `
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vUv = uv;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const earthFragment = /* glsl */ `
  uniform sampler2D night; uniform sampler2D topo; uniform float dim; uniform vec3 rim;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main() {
    vec3 lights = texture2D(night, vUv).rgb;
    float land = texture2D(topo, vUv).r;
    // The night texture's ocean is blue; squaring it keeps city lights and drops the ocean back to navy.
    float luma = dot(lights, vec3(0.3, 0.59, 0.11));
    vec3 cities = lights * smoothstep(0.08, 0.42, luma) * 2.4;
    vec3 base = vec3(0.039, 0.082, 0.137) * 0.85 + vec3(0.06, 0.1, 0.17) * smoothstep(0.01, 0.3, land);
    float fres = pow(1.0 - max(dot(vN, vV), 0.0), 3.5);
    vec3 col = base + cities + rim * fres * 0.4;
    // Dim toward the page colour, not black, so a dimmed globe recedes instead of punching a hole.
    gl_FragColor = vec4(mix(vec3(0.0392, 0.0824, 0.1373), col, dim), 1.0);
  }`;

const glowVertex = /* glsl */ `
  varying vec3 vN; varying vec3 vV;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const glowFragment = /* glsl */ `
  uniform vec3 rim; uniform float dim; varying vec3 vN; varying vec3 vV;
  void main() {
    // On the back of a 1.16 shell, -dot runs 0 at the outer edge to about 0.5 at Earth's limb.
    float x = clamp(-dot(vN, vV) / 0.5, 0.0, 1.0);
    float a = pow(x, 3.4) * 0.62;
    gl_FragColor = vec4(rim * dim, a * dim);
  }`;

const Earth: React.FC<{ night: THREE.Texture; topo: THREE.Texture }> = ({ night, topo }) => {
  const frame = useCurrentFrame();
  const g = globeAt(frame);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const rim = useMemo(() => new THREE.Color(C.accent), []);
  const earthRef = useRef<THREE.ShaderMaterial>(null);
  const glowRef = useRef<THREE.ShaderMaterial>(null);
  const earthUniforms = useMemo(
    () => ({ night: { value: night }, topo: { value: topo }, dim: { value: g.dim }, rim: { value: rim } }),
    // Only the first frame's dim is used here; every later frame writes to the live material below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [night, topo, rim],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const glowUniforms = useMemo(() => ({ rim: { value: rim }, dim: { value: g.dim } }), [rim]);

  // Write to the material three.js actually renders: the object passed as a prop is not the live one,
  // so mutating it froze brightness at whichever frame a render tab happened to start on.
  if (earthRef.current) {
    earthRef.current.uniforms.dim.value = g.dim;
  }
  if (glowRef.current) {
    glowRef.current.uniforms.dim.value = g.dim;
  }

  // The view offset moves the globe on screen without clipping it at a translated canvas edge.
  camera.position.set(0, 0, g.dist);
  camera.setViewOffset(W, H, W / 2 - g.cx, H / 2 - g.cy, W, H);
  camera.updateProjectionMatrix();

  return (
    <>
      <group rotation={[(g.lat * Math.PI) / 180, 0, 0]}>
        <mesh rotation={[0, (-(90 + g.lon) * Math.PI) / 180, 0]}>
          <sphereGeometry args={[1, 128, 96]} />
          <shaderMaterial ref={earthRef} vertexShader={earthVertex} fragmentShader={earthFragment} uniforms={earthUniforms} />
        </mesh>
      </group>
      <mesh scale={1.16}>
        <sphereGeometry args={[1, 96, 64]} />
        <shaderMaterial
          ref={glowRef}
          vertexShader={glowVertex}
          fragmentShader={glowFragment}
          uniforms={glowUniforms}
          side={THREE.BackSide}
          transparent
          depthWrite={false}
        />
      </mesh>
    </>
  );
};

/** The one globe in the film. It lives below every scene and is driven only by GLOBE in choreography.ts. */
export const Globe: React.FC = () => {
  const [textures, setTextures] = useState<{ night: THREE.Texture; topo: THREE.Texture } | null>(null);
  const [handle] = useState(() => delayRender("Loading globe textures"));

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    let cancelled = false;
    Promise.all([
      loader.loadAsync(staticFile("globe/earth-night.jpg")),
      loader.loadAsync(staticFile("globe/earth-topology.png")),
    ]).then(([night, topo]) => {
      if (cancelled) {
        return;
      }
      night.anisotropy = 8;
      setTextures({ night, topo });
      continueRender(handle);
    });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  return (
    <ThreeCanvas
      width={W}
      height={H}
      style={{ position: "absolute", inset: 0 }}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      camera={{ position: [0, 0, 3], fov: GLOBE_FOV, near: 0.01, far: 50 }}
    >
      {textures ? <Earth night={textures.night} topo={textures.topo} /> : null}
    </ThreeCanvas>
  );
};
